import * as RNFS from '@dr.pogodin/react-native-fs';
import {makeAutoObservable, observable, runInAction} from 'mobx';
import {NativeEventEmitter, Platform} from 'react-native';

import {
  DownloadEventCallbacks,
  DownloadJob,
  DownloadMap,
  DownloadProgress,
} from './types';

import {Model} from '../../utils/types';
import {formatBytes, hasEnoughSpace, hfUserAgent} from '../../utils';
import {ensureNotificationPermission} from '../../utils/androidPermission';
import {uiStore} from '../../store';
import NativeDownloadModule from '../../specs/NativeDownloadModule';
import type {
  DownloadConfig,
  DownloadResponse,
} from '../../specs/NativeDownloadModule';

const TAG = 'DownloadManager';

/**
 * Signals a user-cancelled download (vs. a genuine failure) so callers can
 * suppress it: no error surface, no follow-on work.
 */
export class DownloadCancelledError extends Error {
  constructor(public readonly modelId: string) {
    super(`Download cancelled for ${modelId}`);
    this.name = 'DownloadCancelledError';
  }
}

// The HF auth token must never leave huggingface.co. Download URLs are pinned to
// HF at parse time, but this is a defense-in-depth gate so a token can never be
// attached for any other host even if a non-HF URL ever reaches here.
const isHuggingFaceUrl = (url: string | undefined): boolean => {
  if (!url) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.host === 'huggingface.co';
  } catch {
    return false;
  }
};

// Mirror only public model files. API calls, web pages, custom URLs, and
// authenticated downloads stay on their original hosts.
const getPublicHuggingFaceMirrorUrl = (
  url: string | undefined,
): string | null => {
  if (!isHuggingFaceUrl(url)) {
    return null;
  }
  const parsed = new URL(url!);
  if (!parsed.pathname.includes('/resolve/')) {
    return null;
  }
  return `https://hf-mirror.com${parsed.pathname}${parsed.search}${parsed.hash}`;
};

export class DownloadManager {
  private downloadJobs: DownloadMap;
  private callbacks: DownloadEventCallbacks = {};
  private eventEmitter: NativeEventEmitter<{
    onDownloadProgress: [
      {
        downloadId: string;
        url?: string;
        bytesWritten: number;
        totalBytes: number;
        progress: number;
      },
    ];
    onDownloadComplete: [{downloadId: string; url?: string; filePath: string}];
    onDownloadFailed: [
      {downloadId: string; url?: string; error: string; progress?: number},
    ];
  }> | null = null;
  private cancelledModelIds = new Set<string>();
  private androidFallbackJobs = new Set<DownloadJob>();

  constructor() {
    console.log(`${TAG}: Initializing DownloadManager`);
    this.downloadJobs = observable.map(new Map());
    makeAutoObservable(this);

    if (Platform.OS === 'android') {
      this.setupAndroidEventListener();
    }
  }

  private setupAndroidEventListener() {
    if (NativeDownloadModule) {
      console.log(`${TAG}: Setting up Android event listeners`);
      this.eventEmitter = new NativeEventEmitter(NativeDownloadModule as any);

      this.eventEmitter.addListener('onDownloadProgress', event => {
        // console.log(
        //   `${TAG}: Progress event received for ID ${event.downloadId}:`,
        //   {
        //     bytesWritten: event.bytesWritten,
        //     totalBytes: event.totalBytes,
        //     progress: event.progress,
        //   },
        // );

        // Find the job by download ID
        const job = Array.from(this.downloadJobs.values()).find(
          _job => _job.downloadId === event.downloadId,
        );

        if (!job) {
          console.warn(
            `${TAG}: No job found for download ID: ${event.downloadId}. This may indicate the job was completed or cancelled.`,
          );
          return;
        }
        if (event.url && event.url !== job.activeDownloadUrl) {
          return;
        }

        // Calculate speed
        const currentTime = Date.now();
        const timeDiff = (currentTime - job.lastUpdateTime) / 1000 || 1;
        const bytesDiff = event.bytesWritten - job.lastBytesWritten;
        const speedBps = bytesDiff / timeDiff;
        const speedMBps = (speedBps / (1024 * 1024)).toFixed(2);

        // Calculate ETA
        const remainingBytes = event.totalBytes - event.bytesWritten;
        const etaSeconds = speedBps > 0 ? remainingBytes / speedBps : 0;
        const etaMinutes = Math.ceil(etaSeconds / 60);
        const l10nData = uiStore.l10n;
        const etaText =
          etaSeconds >= 60
            ? `${etaMinutes} ${l10nData.common.minutes}`
            : `${Math.ceil(etaSeconds)} ${l10nData.common.seconds}`;

        const progress: DownloadProgress = {
          bytesDownloaded: event.bytesWritten,
          bytesTotal: event.totalBytes,
          progress: event.progress,
          speed: `${formatBytes(event.bytesWritten)} (${speedMBps} MB/s)`,
          eta: etaText,
          rawSpeed: speedBps,
          rawEta: etaSeconds,
        };

        // console.log(
        //   `${TAG}: Updating progress for model ${job.model.id}:`,
        //   progress,
        // );

        // Update job state
        runInAction(() => {
          job.state.progress = progress;
          job.lastBytesWritten = event.bytesWritten;
          job.lastUpdateTime = currentTime;
        });

        this.callbacks.onProgress?.(job.model.id, progress);
      });

      this.eventEmitter.addListener('onDownloadComplete', event => {
        console.log(`${TAG}: Download completed for ID: ${event.downloadId}`);
        // Find the job by download ID
        const job = Array.from(this.downloadJobs.values()).find(
          _job => _job.downloadId === event.downloadId,
        );

        if (job) {
          if (event.url && event.url !== job.activeDownloadUrl) {
            return;
          }
          // Set final state before removing
          runInAction(() => {
            job.state.isDownloading = false;
            job.state.progress = {
              bytesDownloaded: job.state.progress?.bytesTotal || 0,
              bytesTotal: job.state.progress?.bytesTotal || 0,
              progress: 100,
              speed: '0 B/s',
              eta: '0 sec',
              rawSpeed: 0,
              rawEta: 0,
            };
          });
          // Ensure callback is called before removing the job
          this.callbacks.onComplete?.(job.model.id);
          runInAction(() => {
            this.downloadJobs.delete(job.model.id);
          });
          console.log(`${TAG}: Removed completed job: ${job.model.id}`);
        } else {
          console.warn(
            `${TAG}: Completion event received for non-existent job: ${event.downloadId}`,
          );
        }
      });

      this.eventEmitter.addListener('onDownloadFailed', async event => {
        await this.handleAndroidDownloadFailed(event);
      });
    } else {
      console.error(`${TAG}: DownloadModule is not available`);
    }
  }

  private async handleAndroidDownloadFailed(event: {
    downloadId: string;
    url?: string;
    error: string;
    progress?: number;
  }): Promise<void> {
    console.error(
      `${TAG}: (js) Download failed for ID: ${event.downloadId}`,
      event.error,
    );
    const job = Array.from(this.downloadJobs.values()).find(
      candidate => candidate.downloadId === event.downloadId,
    );
    if (!job) {
      console.warn(
        `${TAG}: Failure event received for non-existent job: ${event.downloadId}`,
      );
      return;
    }
    if (this.cancelledModelIds.has(job.model.id) || !job.state.isDownloading) {
      return;
    }
    if (event.url && event.url !== job.activeDownloadUrl) {
      return;
    }
    if (this.androidFallbackJobs.has(job)) {
      // A native row can reuse its ID for the official retry. A matching URL
      // identifies a real official failure; older mirror events were filtered
      // above, and legacy events without a URL are safest to ignore here.
      if (event.url) {
        this.reportAndroidDownloadFailure(
          job,
          new Error(event.error),
          event.progress ?? 0,
        );
      }
      return;
    }

    const officialFallbackUrl = job.officialFallbackUrl;
    if (officialFallbackUrl) {
      this.androidFallbackJobs.add(job);
      runInAction(() => {
        // Consume the fallback before starting it so duplicate native events
        // cannot launch more than one official-source retry.
        job.officialFallbackUrl = undefined;
        job.activeDownloadUrl = officialFallbackUrl;
      });
      try {
        const config: DownloadConfig = {
          destination: job.destination,
          networkType: 'ANY',
          priority: 1,
          progressInterval: 1000,
        };
        // DownloadController resets validators and deletes the .part file when
        // the URL changes, so mirror and official bytes are never mixed.
        const response = await NativeDownloadModule.startDownload(
          officialFallbackUrl,
          config,
        );
        if (
          this.downloadJobs.get(job.model.id) !== job ||
          this.cancelledModelIds.has(job.model.id) ||
          !job.state.isDownloading
        ) {
          // The user cancelled while the native fallback was starting.
          try {
            await NativeDownloadModule.cancelDownload(response.downloadId);
          } catch (cancelError) {
            console.warn(
              `${TAG}: Could not cancel the late fallback download`,
              cancelError,
            );
          }
          return;
        }
        runInAction(() => {
          job.downloadId = response.downloadId;
          job.state.error = null;
          job.state.progress = null;
          job.lastBytesWritten = 0;
          job.lastUpdateTime = Date.now();
        });
        console.log(
          `${TAG}: Retrying ${job.model.id} from Hugging Face with ID: ${response.downloadId}`,
        );
        return;
      } catch (error) {
        if (
          this.downloadJobs.get(job.model.id) !== job ||
          this.cancelledModelIds.has(job.model.id) ||
          !job.state.isDownloading
        ) {
          return;
        }
        this.reportAndroidDownloadFailure(
          job,
          error instanceof Error ? error : new Error(String(error)),
          event.progress ?? 0,
        );
        return;
      } finally {
        this.androidFallbackJobs.delete(job);
      }
    }

    this.reportAndroidDownloadFailure(
      job,
      new Error(event.error),
      event.progress ?? 0,
    );
  }

  private reportAndroidDownloadFailure(
    job: DownloadJob,
    error: Error,
    keptProgress: number,
  ): void {
    runInAction(() => {
      job.state.error = error;
      job.state.isDownloading = false;
    });
    this.callbacks.onError?.(job.model.id, error, keptProgress);
    runInAction(() => {
      this.downloadJobs.delete(job.model.id);
    });
    console.log(`${TAG}: Removed failed job: ${job.model.id}`);
  }

  private calculateEta(
    bytesDownloaded: number,
    totalBytes: number,
    speedBps: number,
  ): string {
    const l10nData = uiStore.l10n;
    if (speedBps <= 0) {
      return l10nData.common.calculating;
    }

    const remainingBytes = totalBytes - bytesDownloaded;
    const etaSeconds = remainingBytes / speedBps;
    const etaMinutes = Math.ceil(etaSeconds / 60);

    const eta =
      etaSeconds >= 60
        ? `${etaMinutes} ${l10nData.common.minutes}`
        : `${Math.ceil(etaSeconds)} ${l10nData.common.seconds}`;
    console.log(`${TAG}: Calculated ETA:`, {
      remainingBytes,
      speedBps,
      eta,
    });
    return eta;
  }

  setCallbacks(callbacks: DownloadEventCallbacks) {
    console.log(`${TAG}: Setting callbacks`);
    this.callbacks = callbacks;
  }

  isDownloading(modelId: string): boolean {
    const isDownloading = this.downloadJobs.has(modelId);
    return isDownloading;
  }

  /** Reactive read of the in-flight download jobs. UI surfaces depend on this. */
  get activeJobs(): DownloadJob[] {
    return Array.from(this.downloadJobs.values()).filter(
      j => j.state.isDownloading,
    );
  }

  getDownloadProgress(modelId: string): number {
    const progress =
      this.downloadJobs.get(modelId)?.state.progress?.progress || 0;
    console.log(`${TAG}: Getting progress for model ${modelId}:`, progress);
    return progress;
  }

  async startDownload(
    model: Model,
    destinationPath: string,
    authToken?: string | null,
  ): Promise<void> {
    console.log(`${TAG}: Starting download for model:`, {
      modelId: model.id,
      destination: destinationPath,
      url: model.downloadUrl,
    });

    if (this.isDownloading(model.id)) {
      console.log(`${TAG}: Download already in progress for model:`, model.id);
      return;
    }

    if (!model.downloadUrl) {
      console.error(`${TAG}: Model has no download URL`);
      throw new Error('Model has no download URL');
    }

    const officialDownloadUrl = model.downloadUrl;
    // Only send the HF auth token to huggingface.co. Authenticated downloads
    // also stay on the official host so private model URLs never hit a mirror.
    const effectiveAuthToken = isHuggingFaceUrl(officialDownloadUrl)
      ? authToken
      : null;
    const mirrorDownloadUrl = effectiveAuthToken
      ? null
      : getPublicHuggingFaceMirrorUrl(officialDownloadUrl);
    const initialDownloadUrl = mirrorDownloadUrl ?? officialDownloadUrl;
    const officialFallbackUrl = mirrorDownloadUrl
      ? officialDownloadUrl
      : undefined;

    const isEnoughSpace = await hasEnoughSpace(model);
    if (!isEnoughSpace) {
      console.error(`${TAG}: Not enough storage space for model:`, {
        modelId: model.id,
        size: model.size,
      });
      throw new Error('Not enough storage space to download the model');
    }

    const dirPath = destinationPath.substring(
      0,
      destinationPath.lastIndexOf('/'),
    );
    try {
      console.log(`${TAG}: Creating directory:`, dirPath);
      await RNFS.mkdir(dirPath);
    } catch (err) {
      console.error(`${TAG}: Failed to create directory:`, err);
      throw err;
    }

    if (Platform.OS === 'ios') {
      await this.startIOSDownload(
        model,
        destinationPath,
        effectiveAuthToken,
        initialDownloadUrl,
        officialFallbackUrl,
      );
    } else {
      await this.startAndroidDownload(
        model,
        destinationPath,
        effectiveAuthToken,
        initialDownloadUrl,
        officialFallbackUrl,
      );
    }
  }

  private async startIOSDownload(
    model: Model,
    destinationPath: string,
    authToken: string | null | undefined,
    initialDownloadUrl: string,
    officialFallbackUrl?: string,
  ): Promise<void> {
    try {
      runInAction(() => {
        this.downloadJobs.set(model.id, {
          model,
          state: {
            isDownloading: true,
            progress: null,
            error: null,
          },
          destination: destinationPath,
          lastBytesWritten: 0,
          lastUpdateTime: Date.now(),
        });
      });
      // observable.map wraps stored objects. Keep the wrapped job so progress
      // and attempt IDs update the same object observed by the UI.
      const downloadJob = this.downloadJobs.get(model.id)!;
      this.callbacks.onStart?.(model.id);

      const runAttempt = async (downloadUrl: string): Promise<Error | null> => {
        try {
          const downloadResult = RNFS.downloadFile({
            fromUrl: downloadUrl,
            toFile: destinationPath,
            background: uiStore.iOSBackgroundDownloading,
            discretionary: false,
            progressInterval: 800,
            headers: {
              'User-Agent': hfUserAgent(),
              ...(authToken && isHuggingFaceUrl(downloadUrl)
                ? {Authorization: `Bearer ${authToken}`}
                : {}),
            },
            begin: res => {
              const job = this.downloadJobs.get(model.id);
              if (job?.jobId !== downloadResult.jobId) {
                return;
              }
              console.log(`${TAG}: Download started for ID: ${model.id}`, {
                statusCode: res.statusCode,
                contentLength: res.contentLength,
                headers: res.headers,
                jobId: downloadResult.jobId,
              });

              const progress: DownloadProgress = {
                bytesDownloaded: 0,
                bytesTotal: res.contentLength,
                progress: 0,
                speed: '0 B/s',
                eta: uiStore.l10n.common.calculating,
                rawSpeed: 0,
                rawEta: 0,
              };

              runInAction(() => {
                job.state.progress = progress;
              });
              this.callbacks.onProgress?.(model.id, progress);
            },
            progress: res => {
              const job = this.downloadJobs.get(model.id);
              if (job?.jobId !== downloadResult.jobId) {
                return;
              }

              const currentTime = Date.now();
              const timeDiff = (currentTime - job.lastUpdateTime) / 1000 || 1;
              const bytesDiff = res.bytesWritten - job.lastBytesWritten;
              const speedBps = bytesDiff / timeDiff;
              const speedMBps = (speedBps / (1024 * 1024)).toFixed(2);

              const remainingBytes = res.contentLength - res.bytesWritten;
              const etaSeconds = speedBps > 0 ? remainingBytes / speedBps : 0;
              const etaMinutes = Math.ceil(etaSeconds / 60);
              const l10nData = uiStore.l10n;
              const etaText =
                etaSeconds >= 60
                  ? `${etaMinutes} ${l10nData.common.minutes}`
                  : `${Math.ceil(etaSeconds)} ${l10nData.common.seconds}`;

              const progress: DownloadProgress = {
                bytesDownloaded: res.bytesWritten,
                bytesTotal: res.contentLength,
                progress: (res.bytesWritten / res.contentLength) * 100,
                speed: `${formatBytes(res.bytesWritten)} (${speedMBps} MB/s)`,
                eta: etaText,
                rawSpeed: speedBps,
                rawEta: etaSeconds,
              };

              runInAction(() => {
                job.state.progress = progress;
                job.lastBytesWritten = res.bytesWritten;
                job.lastUpdateTime = currentTime;
              });

              this.callbacks.onProgress?.(model.id, progress);
            },
          });

          console.log(
            `${TAG}: Created download with jobId: ${downloadResult.jobId}`,
          );
          runInAction(() => {
            if (this.downloadJobs.get(model.id) === downloadJob) {
              downloadJob.jobId = downloadResult.jobId;
            }
          });

          const result = await downloadResult.promise;
          return result.statusCode === 200
            ? null
            : new Error(`Download failed with status: ${result.statusCode}`);
        } catch (error) {
          return error instanceof Error ? error : new Error(String(error));
        }
      };

      let downloadError = await runAttempt(initialDownloadUrl);
      if (
        downloadError &&
        officialFallbackUrl &&
        !this.cancelledModelIds.has(model.id) &&
        this.downloadJobs.get(model.id) === downloadJob
      ) {
        console.warn(
          `${TAG}: Mirror download failed for ${model.id}; retrying from Hugging Face`,
        );
        runInAction(() => {
          downloadJob.state.progress = null;
          downloadJob.lastBytesWritten = 0;
          downloadJob.lastUpdateTime = Date.now();
        });
        try {
          // RNFS writes directly to the destination; do not mix mirror bytes
          // with the official response when retrying.
          await RNFS.unlink(destinationPath);
        } catch (error) {
          if ((error as {code?: string})?.code !== 'ENOENT') {
            throw error;
          }
        }
        if (
          !this.cancelledModelIds.has(model.id) &&
          this.downloadJobs.get(model.id) === downloadJob
        ) {
          downloadError = await runAttempt(officialFallbackUrl);
        }
      }

      if (!downloadError) {
        console.log(
          `${TAG}: Download completed successfully for ID: ${model.id}`,
        );
        this.callbacks.onComplete?.(model.id);
        runInAction(() => {
          this.downloadJobs.delete(model.id);
        });
        // Cancel may race with a download that already completed; clear any
        // stale marker so it can't suppress a later genuine failure.
        this.cancelledModelIds.delete(model.id);
      } else {
        console.error(
          `${TAG}: Download failed for ID: ${model.id}:`,
          downloadError,
        );
        throw downloadError;
      }
    } catch (error) {
      // RNFS.stopDownload aborts the task, rejecting this promise. A user
      // cancel is not a failure — surface it as a distinct cancellation.
      if (this.cancelledModelIds.delete(model.id)) {
        console.log(`${TAG}: Download cancelled by user for ID: ${model.id}`);
        runInAction(() => {
          this.downloadJobs.delete(model.id);
        });
        throw new DownloadCancelledError(model.id);
      }

      console.error(`${TAG}: Download failed for ID: ${model.id}:`, error);
      runInAction(() => {
        const job = this.downloadJobs.get(model.id);
        if (job) {
          job.state.error =
            error instanceof Error ? error : new Error(String(error));
          job.state.isDownloading = false;
        }
        this.downloadJobs.delete(model.id);
      });
      this.callbacks.onError?.(
        model.id,
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
  }

  private async startAndroidDownload(
    model: Model,
    destinationPath: string,
    authToken: string | null | undefined,
    initialDownloadUrl: string,
    officialFallbackUrl?: string,
  ): Promise<void> {
    try {
      console.log(`${TAG}: Starting Android download for model:`, {
        modelId: model.id,
        destination: destinationPath,
      });

      const downloadJob: DownloadJob = {
        model,
        state: {
          isDownloading: true,
          progress: null,
          error: null,
        },
        destination: destinationPath,
        activeDownloadUrl: initialDownloadUrl,
        officialFallbackUrl,
        lastBytesWritten: 0,
        lastUpdateTime: Date.now(),
      };

      // Start the download first to get the download ID
      const config: DownloadConfig = {
        destination: destinationPath,
        networkType: 'ANY',
        priority: 1,
        progressInterval: 1000,
        ...(authToken && isHuggingFaceUrl(initialDownloadUrl)
          ? {authToken}
          : {}),
      };
      await ensureNotificationPermission();
      let response: DownloadResponse;
      try {
        response = await NativeDownloadModule.startDownload(
          initialDownloadUrl,
          config,
        );
      } catch (error) {
        if (!officialFallbackUrl) {
          throw error;
        }
        console.warn(
          `${TAG}: Could not start mirror download for ${model.id}; trying Hugging Face`,
        );
        response = await NativeDownloadModule.startDownload(
          officialFallbackUrl,
          config,
        );
        downloadJob.officialFallbackUrl = undefined;
        downloadJob.activeDownloadUrl = officialFallbackUrl;
      }

      // Store the download ID
      downloadJob.downloadId = response.downloadId;
      console.log(`${TAG}: Download started with ID: ${response.downloadId}`);

      // Add job to map after getting download ID
      runInAction(() => {
        this.downloadJobs.set(model.id, downloadJob);
      });
      this.callbacks.onStart?.(model.id);
    } catch (error) {
      console.error(`${TAG}: Failed to start Android download:`, {
        modelId: model.id,
        error: error instanceof Error ? error.message : String(error),
      });

      runInAction(() => {
        const job = this.downloadJobs.get(model.id);
        if (job) {
          job.state.error =
            error instanceof Error ? error : new Error(String(error));
          job.state.isDownloading = false;
        }
        this.downloadJobs.delete(model.id);
      });
      this.callbacks.onError?.(
        model.id,
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
  }

  async cancelDownload(modelId: string): Promise<void> {
    console.log(`${TAG}: Attempting to cancel download:`, modelId);
    const job = this.downloadJobs.get(modelId);
    if (job) {
      // Mark as user-cancelled so the iOS download promise rejection is
      // recognised as a cancel, not surfaced as a "Download Failed" error.
      this.cancelledModelIds.add(modelId);
      runInAction(() => {
        // Invalidate the job before the first await so a late native failure
        // cannot start the official-source fallback while cancellation runs.
        job.state.isDownloading = false;
        job.officialFallbackUrl = undefined;
      });
      try {
        if (Platform.OS === 'ios') {
          console.log(
            `${TAG}: Cancelling iOS download for ID: ${modelId}, jobId: ${job.jobId}`,
          );
          if (job.jobId) {
            RNFS.stopDownload(job.jobId); // job.jobId is now correctly typed as number
          }
        } else if (
          Platform.OS === 'android' &&
          NativeDownloadModule &&
          job.downloadId
        ) {
          console.log(`${TAG}: Cancelling Android download:`, modelId);
          await NativeDownloadModule.cancelDownload(job.downloadId);
          // Android cancel emits no failure event, so nothing consumes the
          // cancelled-id marker — clear it here to avoid leaking entries.
          this.cancelledModelIds.delete(modelId);
        }

        // Clean up the partial download file
        const destinationPath = job.destination;
        if (destinationPath) {
          console.log(
            `${TAG}: Cleaning up partial download file:`,
            destinationPath,
          );
          try {
            const exists = await RNFS.exists(destinationPath);
            if (exists) {
              await RNFS.unlink(destinationPath);
              console.log(
                `${TAG}: Successfully deleted partial download file:`,
                destinationPath,
              );
            }
          } catch (fileError) {
            if ((fileError as any)?.code !== 'ENOENT') {
              console.error(`${TAG}: Error deleting partial download file:`, {
                path: destinationPath,
                error:
                  fileError instanceof Error
                    ? fileError.message
                    : String(fileError),
              });
            }
          }
        }

        // Update state and remove job
        runInAction(() => {
          job.state.isDownloading = false;
          this.downloadJobs.delete(modelId);
        });
        console.log(`${TAG}: Removed cancelled job:`, modelId);
      } catch (err) {
        console.error(`${TAG}: Error cancelling download:`, {
          modelId,
          error: err instanceof Error ? err.message : String(err),
        });
        this.cancelledModelIds.delete(modelId);
      }
    } else {
      console.warn(`${TAG}: No download job found to cancel:`, modelId);
    }
  }

  cleanup() {
    console.log(`${TAG}: Cleaning up download manager`);
    if (Platform.OS === 'android' && this.eventEmitter) {
      console.log(`${TAG}: Removing Android event listeners`);
      this.eventEmitter.removeAllListeners('onDownloadProgress');
      this.eventEmitter.removeAllListeners('onDownloadComplete');
      this.eventEmitter.removeAllListeners('onDownloadFailed');
    }
    this.downloadJobs.clear();
    this.cancelledModelIds.clear();
    this.androidFallbackJobs.clear();
    console.log(`${TAG}: Download jobs cleared`);
  }

  /**
   * Synchronizes the downloadJobs map with active downloads in the native layer.
   * This should be called after the model store is initialized.
   */
  syncWithActiveDownloads = async (models: Model[]): Promise<void> => {
    if (Platform.OS !== 'android' || !NativeDownloadModule) {
      return;
    }

    try {
      console.log(`${TAG}: Syncing download jobs with native layer`);

      // Get active downloads from native module
      const activeDownloads = await NativeDownloadModule.getActiveDownloads();
      console.log(
        `${TAG}: Found ${activeDownloads.length} active downloads in native layer`,
      );

      if (activeDownloads.length === 0) {
        return;
      }

      // For each active download, find the corresponding model and create a download job
      for (const download of activeDownloads) {
        const model = models.find(m => {
          return (
            m.downloadUrl &&
            (download.url === m.downloadUrl ||
              download.url === getPublicHuggingFaceMirrorUrl(m.downloadUrl))
          );
        });

        if (!model) {
          console.warn(
            `${TAG}: Could not find model for download: ${download.destination}`,
          );
          continue;
        }

        // Parse progress value safely
        const progress =
          typeof download.progress === 'string'
            ? parseFloat(download.progress)
            : download.progress || 0;

        // Calculate bytes from model size and progress
        const totalBytes = model.size || 0;
        const bytesWritten = Math.floor((totalBytes * progress) / 100);

        // Create a download job for this model
        const downloadJob: DownloadJob = {
          model,
          downloadId: download.id,
          state: {
            isDownloading: true,
            progress: {
              bytesDownloaded: bytesWritten,
              bytesTotal: totalBytes,
              progress: progress,
              speed: '0 B/s',
              eta: uiStore.l10n.common.calculating,
              rawSpeed: 0,
              rawEta: 0,
            },
            error: null,
          },
          destination: download.destination,
          activeDownloadUrl: download.url,
          officialFallbackUrl:
            model.downloadUrl &&
            download.url === getPublicHuggingFaceMirrorUrl(model.downloadUrl)
              ? model.downloadUrl
              : undefined,
          lastBytesWritten: bytesWritten,
          lastUpdateTime: Date.now(),
        };

        // Add to downloadJobs map
        runInAction(() => {
          this.downloadJobs.set(model.id, downloadJob);
        });
        console.log(
          `${TAG}: Restored download job for model: ${model.id}, progress: ${progress}%`,
        );

        // Notify listeners that download is in progress
        this.callbacks.onStart?.(model.id);

        // Re-register for progress updates by calling the native module
        try {
          // We need to tell the native module to re-register the observer for this download
          if (NativeDownloadModule.reattachDownloadObserver) {
            await NativeDownloadModule.reattachDownloadObserver(download.id);
            console.log(
              `${TAG}: Re-attached observer for download ID: ${download.id}`,
            );
          } else {
            console.warn(
              `${TAG}: reattachDownloadObserver method not available in NativeDownloadModule`,
            );
          }
        } catch (error) {
          console.error(`${TAG}: Error re-attaching observer:`, error);
        }
      }
    } catch (error) {
      console.error(`${TAG}: Error syncing download jobs:`, error);
    }
  };
}
