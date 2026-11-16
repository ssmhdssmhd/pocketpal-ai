import {NativeModules, Platform, NativeEventEmitter} from 'react-native';

import * as RNFS from '@dr.pogodin/react-native-fs';

import {basicModel} from '../../../../jest/fixtures/models';

import {DownloadManager, DownloadCancelledError} from '../DownloadManager';
import {ensureNotificationPermission} from '../../../utils/androidPermission';

const hfFileModel = {
  ...basicModel,
  downloadUrl:
    'https://huggingface.co/test/test-model-1/resolve/main/test-model-1.gguf',
};
const hfMirrorUrl =
  'https://hf-mirror.com/test/test-model-1/resolve/main/test-model-1.gguf';

jest.mock('../../../utils/androidPermission', () => ({
  ensureNotificationPermission: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('react-native', () => {
  // Create a shared mock for DownloadModule inside the factory
  const mockDownloadModule = {
    startDownload: jest.fn(),
    cancelDownload: jest.fn(),
    getActiveDownloads: jest.fn(),
    reattachDownloadObserver: jest.fn(),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
    pauseDownload: jest.fn(),
    resumeDownload: jest.fn(),
    retryDownload: jest.fn(),
    logDownloadDatabase: jest.fn(),
  };

  return {
    NativeModules: {
      DownloadModule: mockDownloadModule,
    },
    NativeEventEmitter: jest.fn(),
    Platform: {
      OS: 'android',
    },
    Appearance: {
      getColorScheme: jest.fn(() => 'light'),
    },
    TurboModuleRegistry: {
      getEnforcing: jest.fn((name: string) => {
        if (name === 'DownloadModule') {
          return mockDownloadModule;
        }
        return null;
      }),
    },
  };
});

describe('DownloadManager', () => {
  let downloadManager: DownloadManager;
  let mockEventEmitter: any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup mock event emitter
    mockEventEmitter = {
      addListener: jest.fn(),
      removeAllListeners: jest.fn(),
    };
    (NativeEventEmitter as jest.Mock).mockReturnValue(mockEventEmitter);

    // Reset platform to Android by default
    (Platform as any).OS = 'android';

    downloadManager = new DownloadManager();
  });

  it('initializes correctly', () => {
    expect(downloadManager).toBeDefined();
    expect(NativeEventEmitter).toHaveBeenCalled();
    expect(mockEventEmitter.addListener).toHaveBeenCalledWith(
      'onDownloadProgress',
      expect.any(Function),
    );
    expect(mockEventEmitter.addListener).toHaveBeenCalledWith(
      'onDownloadComplete',
      expect.any(Function),
    );
    expect(mockEventEmitter.addListener).toHaveBeenCalledWith(
      'onDownloadFailed',
      expect.any(Function),
    );
  });

  it('starts a download on Android', async () => {
    NativeModules.DownloadModule.startDownload.mockResolvedValue({
      downloadId: 'download123',
    });

    const callbacks = {
      onStart: jest.fn(),
      onProgress: jest.fn(),
      onComplete: jest.fn(),
      onError: jest.fn(),
    };

    downloadManager.setCallbacks(callbacks);

    await downloadManager.startDownload(basicModel, '/path/to/model.bin');

    expect(RNFS.mkdir).toHaveBeenCalledWith('/path/to');
    expect(NativeModules.DownloadModule.startDownload).toHaveBeenCalledWith(
      basicModel.downloadUrl,
      expect.objectContaining({
        destination: '/path/to/model.bin',
      }),
    );
    expect(callbacks.onStart).toHaveBeenCalledWith('model-1');
    expect(downloadManager.isDownloading('model-1')).toBe(true);
  });

  it('uses the public mirror for an unauthenticated HF file on Android', async () => {
    NativeModules.DownloadModule.startDownload.mockResolvedValue({
      downloadId: 'mirror-download',
    });

    await downloadManager.startDownload(hfFileModel, '/path/to/model.bin');

    expect(NativeModules.DownloadModule.startDownload).toHaveBeenCalledWith(
      hfMirrorUrl,
      expect.objectContaining({
        destination: '/path/to/model.bin',
      }),
    );
    const config = NativeModules.DownloadModule.startDownload.mock.calls[0][1];
    expect(config.authToken).toBeUndefined();
  });

  it('keeps authenticated HF downloads on the official host on Android', async () => {
    NativeModules.DownloadModule.startDownload.mockResolvedValue({
      downloadId: 'official-download',
    });

    await downloadManager.startDownload(
      hfFileModel,
      '/path/to/model.bin',
      'secret-token',
    );

    expect(NativeModules.DownloadModule.startDownload).toHaveBeenCalledTimes(1);
    expect(NativeModules.DownloadModule.startDownload).toHaveBeenCalledWith(
      hfFileModel.downloadUrl,
      expect.objectContaining({authToken: 'secret-token'}),
    );
  });

  it('falls back to HF and tracks the new Android download ID', async () => {
    NativeModules.DownloadModule.startDownload
      .mockResolvedValueOnce({downloadId: 'mirror-download'})
      .mockResolvedValueOnce({downloadId: 'official-download'});
    const callbacks = {onError: jest.fn(), onComplete: jest.fn()};
    downloadManager.setCallbacks(callbacks);
    await downloadManager.startDownload(hfFileModel, '/path/to/model.bin');
    const [, emitFailure] = mockEventEmitter.addListener.mock.calls.find(
      ([name]: [string]) => name === 'onDownloadFailed',
    );
    const [, emitComplete] = mockEventEmitter.addListener.mock.calls.find(
      ([name]: [string]) => name === 'onDownloadComplete',
    );

    await emitFailure({downloadId: 'mirror-download', error: 'stalled'});

    expect(NativeModules.DownloadModule.startDownload).toHaveBeenNthCalledWith(
      2,
      hfFileModel.downloadUrl,
      expect.objectContaining({destination: '/path/to/model.bin'}),
    );
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(downloadManager.isDownloading('model-1')).toBe(true);

    emitComplete({
      downloadId: 'official-download',
      filePath: '/path/to/model.bin',
    });
    expect(callbacks.onComplete).toHaveBeenCalledWith('model-1');
    expect(downloadManager.isDownloading('model-1')).toBe(false);
  });

  it('reports an Android error only after the official fallback also fails', async () => {
    NativeModules.DownloadModule.startDownload
      .mockResolvedValueOnce({downloadId: 'mirror-download'})
      .mockResolvedValueOnce({downloadId: 'official-download'});
    const onError = jest.fn();
    downloadManager.setCallbacks({onError});
    await downloadManager.startDownload(hfFileModel, '/path/to/model.bin');
    const [, emitFailure] = mockEventEmitter.addListener.mock.calls.find(
      ([name]: [string]) => name === 'onDownloadFailed',
    );

    await emitFailure({downloadId: 'mirror-download', error: 'mirror failed'});
    expect(onError).not.toHaveBeenCalled();
    await emitFailure({
      downloadId: 'official-download',
      error: 'official failed',
      progress: 25,
    });

    expect(onError).toHaveBeenCalledWith(
      'model-1',
      expect.objectContaining({message: 'official failed'}),
      25,
    );
    expect(downloadManager.isDownloading('model-1')).toBe(false);
  });

  it('does not start an Android fallback after user cancellation', async () => {
    NativeModules.DownloadModule.startDownload.mockResolvedValue({
      downloadId: 'mirror-download',
    });
    const onError = jest.fn();
    downloadManager.setCallbacks({onError});
    await downloadManager.startDownload(hfFileModel, '/path/to/model.bin');
    const [, emitFailure] = mockEventEmitter.addListener.mock.calls.find(
      ([name]: [string]) => name === 'onDownloadFailed',
    );

    await downloadManager.cancelDownload('model-1');
    await emitFailure({downloadId: 'mirror-download', error: 'cancelled'});

    expect(NativeModules.DownloadModule.startDownload).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('does not fall back while Android cancellation is still pending', async () => {
    NativeModules.DownloadModule.startDownload.mockResolvedValue({
      downloadId: 'mirror-download',
    });
    let finishNativeCancel: () => void = () => {};
    const nativeCancel = new Promise<void>(resolve => {
      finishNativeCancel = resolve;
    });
    NativeModules.DownloadModule.cancelDownload.mockReturnValue(nativeCancel);
    const onError = jest.fn();
    downloadManager.setCallbacks({onError});
    await downloadManager.startDownload(hfFileModel, '/path/to/model.bin');
    const [, emitFailure] = mockEventEmitter.addListener.mock.calls.find(
      ([name]: [string]) => name === 'onDownloadFailed',
    );

    const cancellation = downloadManager.cancelDownload('model-1');
    await emitFailure({downloadId: 'mirror-download', error: 'stalled'});

    expect(NativeModules.DownloadModule.startDownload).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();

    finishNativeCancel();
    await cancellation;
    expect(downloadManager.isDownloading('model-1')).toBe(false);
  });

  it('ignores duplicate mirror failures while the Android fallback starts', async () => {
    let resolveFallback: (response: {downloadId: string}) => void = () => {};
    const fallbackResponse = new Promise<{downloadId: string}>(resolve => {
      resolveFallback = resolve;
    });
    NativeModules.DownloadModule.startDownload
      .mockResolvedValueOnce({downloadId: 'mirror-download'})
      .mockReturnValueOnce(fallbackResponse);
    const onError = jest.fn();
    downloadManager.setCallbacks({onError});
    await downloadManager.startDownload(hfFileModel, '/path/to/model.bin');
    const [, emitFailure] = mockEventEmitter.addListener.mock.calls.find(
      ([name]: [string]) => name === 'onDownloadFailed',
    );

    const firstFailure = emitFailure({
      downloadId: 'mirror-download',
      error: 'mirror failed',
    });
    await emitFailure({
      downloadId: 'mirror-download',
      error: 'duplicate mirror failure',
    });

    expect(NativeModules.DownloadModule.startDownload).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
    expect(downloadManager.isDownloading('model-1')).toBe(true);

    resolveFallback({downloadId: 'official-download'});
    await firstFailure;
    expect(onError).not.toHaveBeenCalled();
    expect(downloadManager.isDownloading('model-1')).toBe(true);
  });

  it('cancels a late Android fallback response after user cancellation', async () => {
    let resolveFallback: (response: {downloadId: string}) => void = () => {};
    const fallbackResponse = new Promise<{downloadId: string}>(resolve => {
      resolveFallback = resolve;
    });
    NativeModules.DownloadModule.startDownload
      .mockResolvedValueOnce({downloadId: 'mirror-download'})
      .mockReturnValueOnce(fallbackResponse);
    NativeModules.DownloadModule.cancelDownload.mockResolvedValue(undefined);
    const onError = jest.fn();
    downloadManager.setCallbacks({onError});
    await downloadManager.startDownload(hfFileModel, '/path/to/model.bin');
    const [, emitFailure] = mockEventEmitter.addListener.mock.calls.find(
      ([name]: [string]) => name === 'onDownloadFailed',
    );

    const fallbackFailure = emitFailure({
      downloadId: 'mirror-download',
      error: 'mirror failed',
    });
    await downloadManager.cancelDownload('model-1');
    resolveFallback({downloadId: 'official-download'});
    await fallbackFailure;

    expect(NativeModules.DownloadModule.cancelDownload).toHaveBeenNthCalledWith(
      1,
      'mirror-download',
    );
    expect(NativeModules.DownloadModule.cancelDownload).toHaveBeenNthCalledWith(
      2,
      'official-download',
    );
    expect(onError).not.toHaveBeenCalled();
    expect(downloadManager.isDownloading('model-1')).toBe(false);
  });

  it('reports an official failure with a reused ID while fallback starts', async () => {
    let resolveFallback: (response: {downloadId: string}) => void = () => {};
    const fallbackResponse = new Promise<{downloadId: string}>(resolve => {
      resolveFallback = resolve;
    });
    NativeModules.DownloadModule.startDownload
      .mockResolvedValueOnce({downloadId: 'shared-download'})
      .mockReturnValueOnce(fallbackResponse);
    const onError = jest.fn();
    downloadManager.setCallbacks({onError});
    await downloadManager.startDownload(hfFileModel, '/path/to/model.bin');
    const [, emitFailure] = mockEventEmitter.addListener.mock.calls.find(
      ([name]: [string]) => name === 'onDownloadFailed',
    );

    const fallbackStart = emitFailure({
      downloadId: 'shared-download',
      url: hfMirrorUrl,
      error: 'mirror failed',
    });
    await emitFailure({
      downloadId: 'shared-download',
      url: hfFileModel.downloadUrl,
      error: 'official failed',
      progress: 25,
    });

    expect(onError).toHaveBeenCalledWith(
      'model-1',
      expect.objectContaining({message: 'official failed'}),
      25,
    );
    expect(downloadManager.isDownloading('model-1')).toBe(false);

    resolveFallback({downloadId: 'shared-download'});
    await fallbackStart;
  });

  it('ignores stale mirror events after Android reuses the download ID', async () => {
    NativeModules.DownloadModule.startDownload.mockResolvedValue({
      downloadId: 'shared-download',
    });
    const callbacks = {
      onProgress: jest.fn(),
      onComplete: jest.fn(),
      onError: jest.fn(),
    };
    downloadManager.setCallbacks(callbacks);
    await downloadManager.startDownload(hfFileModel, '/path/to/model.bin');
    const [, emitFailure] = mockEventEmitter.addListener.mock.calls.find(
      ([name]: [string]) => name === 'onDownloadFailed',
    );
    const [, emitComplete] = mockEventEmitter.addListener.mock.calls.find(
      ([name]: [string]) => name === 'onDownloadComplete',
    );
    const [, emitProgress] = mockEventEmitter.addListener.mock.calls.find(
      ([name]: [string]) => name === 'onDownloadProgress',
    );
    await emitFailure({
      downloadId: 'shared-download',
      url: hfMirrorUrl,
      error: 'mirror failed',
    });

    emitProgress({
      downloadId: 'shared-download',
      url: hfMirrorUrl,
      bytesWritten: 100,
      totalBytes: 1000,
      progress: 10,
    });
    emitComplete({
      downloadId: 'shared-download',
      url: hfMirrorUrl,
      filePath: '/path/to/model.bin',
    });
    await emitFailure({
      downloadId: 'shared-download',
      url: hfMirrorUrl,
      error: 'late mirror failure',
    });

    expect(callbacks.onProgress).not.toHaveBeenCalled();
    expect(callbacks.onComplete).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(downloadManager.isDownloading('model-1')).toBe(true);

    emitComplete({
      downloadId: 'shared-download',
      url: hfFileModel.downloadUrl,
      filePath: '/path/to/model.bin',
    });
    expect(callbacks.onComplete).toHaveBeenCalledWith('model-1');
    expect(downloadManager.isDownloading('model-1')).toBe(false);
  });

  it('asks for notification permission before starting on Android', async () => {
    const order: string[] = [];
    (ensureNotificationPermission as jest.Mock).mockImplementation(async () => {
      order.push('permission');
    });
    NativeModules.DownloadModule.startDownload.mockImplementation(async () => {
      order.push('start');
      return {downloadId: 'download123'};
    });

    await downloadManager.startDownload(basicModel, '/path/to/model.bin');

    expect(order).toEqual(['permission', 'start']);
  });

  it('passes the progress Android kept to onError on failure', async () => {
    NativeModules.DownloadModule.startDownload.mockResolvedValue({
      downloadId: 'download123',
    });
    const onError = jest.fn();
    downloadManager.setCallbacks({onError});
    await downloadManager.startDownload(basicModel, '/path/to/model.bin');
    const [, emitFailure] = mockEventEmitter.addListener.mock.calls.find(
      ([name]: [string]) => name === 'onDownloadFailed',
    );

    emitFailure({downloadId: 'download123', error: 'stalled', progress: 40});

    expect(onError).toHaveBeenCalledWith('model-1', expect.any(Error), 40);
    expect(downloadManager.isDownloading('model-1')).toBe(false);
  });

  it('starts a download on iOS', async () => {
    (Platform as any).OS = 'ios';

    const mockDownloadResult = {
      jobId: 123,
      promise: Promise.resolve({statusCode: 200}),
    };

    (RNFS.downloadFile as jest.Mock).mockReturnValue(mockDownloadResult);

    const callbacks = {
      onStart: jest.fn(),
      onProgress: jest.fn(),
      onComplete: jest.fn(),
      onError: jest.fn(),
    };

    downloadManager.setCallbacks(callbacks);

    await downloadManager.startDownload(basicModel, '/path/to/model.bin');

    expect(RNFS.mkdir).toHaveBeenCalledWith('/path/to');
    expect(RNFS.downloadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        fromUrl: basicModel.downloadUrl,
        toFile: '/path/to/model.bin',
      }),
    );

    expect(callbacks.onComplete).toHaveBeenCalledWith('model-1');
    expect(downloadManager.isDownloading('model-1')).toBe(false);
  });

  it('falls back from the mirror to HF on iOS without mixing partial data', async () => {
    (Platform as any).OS = 'ios';
    const iosDownloadManager = new DownloadManager();
    const callbacks = {onError: jest.fn(), onComplete: jest.fn()};
    iosDownloadManager.setCallbacks(callbacks);
    (RNFS.downloadFile as jest.Mock)
      .mockReturnValueOnce({
        jobId: 100,
        promise: Promise.resolve({statusCode: 404}),
      })
      .mockReturnValueOnce({
        jobId: 101,
        promise: Promise.resolve({statusCode: 200}),
      });

    await iosDownloadManager.startDownload(hfFileModel, '/path/to/model.bin');

    expect(RNFS.downloadFile).toHaveBeenCalledTimes(2);
    expect((RNFS.downloadFile as jest.Mock).mock.calls[0][0].fromUrl).toBe(
      hfMirrorUrl,
    );
    expect((RNFS.downloadFile as jest.Mock).mock.calls[1][0].fromUrl).toBe(
      hfFileModel.downloadUrl,
    );
    expect(RNFS.unlink).toHaveBeenCalledWith('/path/to/model.bin');
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.onComplete).toHaveBeenCalledWith('model-1');
  });

  it('reports the official iOS failure after both sources fail', async () => {
    (Platform as any).OS = 'ios';
    const iosDownloadManager = new DownloadManager();
    const onError = jest.fn();
    iosDownloadManager.setCallbacks({onError});
    (RNFS.downloadFile as jest.Mock)
      .mockReturnValueOnce({
        jobId: 102,
        promise: Promise.reject(new Error('mirror unavailable')),
      })
      .mockReturnValueOnce({
        jobId: 103,
        promise: Promise.reject(new Error('official unavailable')),
      });

    await expect(
      iosDownloadManager.startDownload(hfFileModel, '/path/to/model.bin'),
    ).rejects.toThrow('official unavailable');

    expect(RNFS.downloadFile).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      'model-1',
      expect.objectContaining({message: 'official unavailable'}),
    );
  });

  it('cancels a download', async () => {
    // Setup a download first
    NativeModules.DownloadModule.startDownload.mockResolvedValue({
      downloadId: 'download123',
    });

    await downloadManager.startDownload(basicModel, '/path/to/model.bin');
    expect(downloadManager.isDownloading('model-1')).toBe(true);

    // Now cancel it
    await downloadManager.cancelDownload('model-1');

    expect(NativeModules.DownloadModule.cancelDownload).toHaveBeenCalledWith(
      'download123',
    );
    expect(downloadManager.isDownloading('model1')).toBe(false);
  });

  it('syncs with active downloads', async () => {
    NativeModules.DownloadModule.getActiveDownloads.mockResolvedValue([
      {
        id: 'download123',
        url: basicModel.downloadUrl,
        destination: '/path/to/model.bin',
        bytesWritten: 500000,
        totalBytes: 1000000,
        progress: 50,
      },
    ]);

    const callbacks = {
      onStart: jest.fn(),
    };

    downloadManager.setCallbacks(callbacks);

    await downloadManager.syncWithActiveDownloads([basicModel]);

    expect(NativeModules.DownloadModule.getActiveDownloads).toHaveBeenCalled();
    expect(downloadManager.isDownloading('model-1')).toBe(true);
    expect(downloadManager.getDownloadProgress('model-1')).toBe(50);
    expect(callbacks.onStart).toHaveBeenCalledWith('model-1');
  });

  it('handles download progress events', async () => {
    // Setup a download first
    NativeModules.DownloadModule.startDownload.mockResolvedValue({
      downloadId: 'download123',
    });

    const callbacks = {
      onStart: jest.fn(),
      onProgress: jest.fn(),
    };

    downloadManager.setCallbacks(callbacks);

    // Start download and wait for it to complete
    await downloadManager.startDownload(basicModel, '/path/to/model.bin');

    // Verify the download job was created
    expect(downloadManager.isDownloading('model-1')).toBe(true);

    // Get the progress listener directly from the mock
    const progressListener = mockEventEmitter.addListener.mock.calls.find(
      call => call[0] === 'onDownloadProgress',
    )[1];

    // Call the progress listener with a mock event that matches model ID
    progressListener({
      downloadId: 'download123',
      bytesWritten: 500000,
      totalBytes: 1000000,
      progress: 50,
    });

    // Now check if onProgress was called
    expect(callbacks.onProgress).toHaveBeenCalledWith(
      'model-1', // Make sure this matches model ID
      expect.objectContaining({
        bytesDownloaded: 500000,
        bytesTotal: 1000000,
        progress: 50,
      }),
    );
  });

  it('starts and manages a download on iOS', async () => {
    // Set platform to iOS
    (Platform as any).OS = 'ios';

    // Create a new instance for iOS testing
    const iosDownloadManager = new DownloadManager();

    const callbacks = {
      onStart: jest.fn(),
      onProgress: jest.fn(),
      onComplete: jest.fn(),
      onError: jest.fn(),
    };

    iosDownloadManager.setCallbacks(callbacks);

    let beginCallback: any;
    let progressCallback: any;

    const mockDownloadResult = {
      jobId: 456,
      promise: Promise.resolve({statusCode: 200}),
    };

    (RNFS.downloadFile as jest.Mock).mockImplementation(options => {
      // Save the callbacks so we can call them manually
      beginCallback = options.begin;
      progressCallback = options.progress;
      return mockDownloadResult;
    });

    // Start the download
    const downloadPromise = iosDownloadManager.startDownload(
      basicModel,
      '/path/to/model.bin',
    );

    await jest.runAllTimersAsync();

    expect(RNFS.mkdir).toHaveBeenCalledWith('/path/to');

    expect(RNFS.downloadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        fromUrl: basicModel.downloadUrl,
        toFile: '/path/to/model.bin',
        discretionary: false,
      }),
    );

    expect(iosDownloadManager.isDownloading('model-1')).toBe(true);

    // Simulate begin callback
    beginCallback({
      statusCode: 200,
      contentLength: 1000000,
      headers: {},
    });

    expect(callbacks.onStart).toHaveBeenCalledWith('model-1');
    expect(callbacks.onProgress).toHaveBeenCalledWith(
      'model-1',
      expect.objectContaining({
        bytesDownloaded: 0,
        bytesTotal: 1000000,
        progress: 0,
      }),
    );
    expect(iosDownloadManager.activeJobs[0].state.progress).toEqual(
      expect.objectContaining({bytesTotal: 1000000, progress: 0}),
    );

    // Reset mock to check next call
    callbacks.onProgress.mockClear();

    // Simulate progress callback (50%)
    progressCallback({
      bytesWritten: 500000,
      contentLength: 1000000,
    });

    expect(callbacks.onProgress).toHaveBeenCalledWith(
      'model-1',
      expect.objectContaining({
        bytesDownloaded: 500000,
        bytesTotal: 1000000,
        progress: 50,
      }),
    );
    expect(iosDownloadManager.activeJobs[0].state.progress).toEqual(
      expect.objectContaining({bytesDownloaded: 500000, progress: 50}),
    );
    expect(iosDownloadManager.getDownloadProgress('model-1')).toBe(50);

    // Wait for the download promise to resolve
    await downloadPromise;

    expect(callbacks.onComplete).toHaveBeenCalledWith('model-1');
    expect(iosDownloadManager.isDownloading('model-1')).toBe(false);
  });

  it('handles download failure on iOS', async () => {
    // Set platform to iOS
    (Platform as any).OS = 'ios';

    // Create a new instance for iOS testing
    const iosDownloadManager = new DownloadManager();

    const callbacks = {
      onStart: jest.fn(),
      onProgress: jest.fn(),
      onComplete: jest.fn(),
      onError: jest.fn(),
    };

    iosDownloadManager.setCallbacks(callbacks);

    const mockDownloadResult = {
      jobId: 789,
      promise: Promise.resolve({statusCode: 404}), // Error status
    };

    (RNFS.downloadFile as jest.Mock).mockReturnValue(mockDownloadResult);

    await expect(
      iosDownloadManager.startDownload(basicModel, '/path/to/model.bin'),
    ).rejects.toThrow('Download failed with status: 404');

    expect(callbacks.onError).toHaveBeenCalledWith(
      'model-1',
      expect.any(Error),
    );

    expect(iosDownloadManager.isDownloading('model-1')).toBe(false);
  });

  it('does not surface an error when an iOS download is cancelled', async () => {
    (Platform as any).OS = 'ios';

    const iosDownloadManager = new DownloadManager();

    const callbacks = {
      onStart: jest.fn(),
      onProgress: jest.fn(),
      onComplete: jest.fn(),
      onError: jest.fn(),
    };

    iosDownloadManager.setCallbacks(callbacks);

    // A cancel aborts the RNFS task, rejecting the download promise.
    let rejectDownload: (reason: Error) => void = () => {};
    const downloadPromise = new Promise((_resolve, reject) => {
      rejectDownload = reject;
    });

    (RNFS.downloadFile as jest.Mock).mockReturnValue({
      jobId: 321,
      promise: downloadPromise,
    });

    const startPromise = iosDownloadManager.startDownload(
      hfFileModel,
      '/path/to/model.bin',
    );

    // Let the async setup (mkdir, job registration) settle before cancelling.
    await new Promise(resolve => setImmediate(resolve));

    expect(iosDownloadManager.isDownloading('model-1')).toBe(true);

    // User taps Stop, then the aborted task rejects the download promise.
    await iosDownloadManager.cancelDownload('model-1');
    rejectDownload(new Error('Download has been aborted'));

    // The cancel surfaces as a distinct DownloadCancelledError (not a generic
    // failure), so onError is never called and callers can special-case it.
    await expect(startPromise).rejects.toBeInstanceOf(DownloadCancelledError);

    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(RNFS.downloadFile).toHaveBeenCalledTimes(1);
    expect(iosDownloadManager.isDownloading('model-1')).toBe(false);
  });

  it('still surfaces an error for a genuine iOS download failure', async () => {
    (Platform as any).OS = 'ios';

    const iosDownloadManager = new DownloadManager();

    const callbacks = {
      onStart: jest.fn(),
      onProgress: jest.fn(),
      onComplete: jest.fn(),
      onError: jest.fn(),
    };

    iosDownloadManager.setCallbacks(callbacks);

    (RNFS.downloadFile as jest.Mock).mockReturnValue({
      jobId: 654,
      promise: Promise.reject(new Error('Network connection lost')),
    });

    await expect(
      iosDownloadManager.startDownload(basicModel, '/path/to/model.bin'),
    ).rejects.toThrow('Network connection lost');

    expect(callbacks.onError).toHaveBeenCalledWith(
      'model-1',
      expect.any(Error),
    );
    expect(iosDownloadManager.isDownloading('model-1')).toBe(false);
  });

  it('still surfaces a later genuine failure after the same model was cancelled', async () => {
    (Platform as any).OS = 'ios';

    const iosDownloadManager = new DownloadManager();

    const callbacks = {
      onStart: jest.fn(),
      onProgress: jest.fn(),
      onComplete: jest.fn(),
      onError: jest.fn(),
    };

    iosDownloadManager.setCallbacks(callbacks);

    // First attempt: user cancels mid-download.
    let rejectFirst: (reason: Error) => void = () => {};
    const firstPromise = new Promise((_resolve, reject) => {
      rejectFirst = reject;
    });
    (RNFS.downloadFile as jest.Mock).mockReturnValueOnce({
      jobId: 111,
      promise: firstPromise,
    });

    const firstStart = iosDownloadManager.startDownload(
      basicModel,
      '/path/to/model.bin',
    );
    await new Promise(resolve => setImmediate(resolve));
    await iosDownloadManager.cancelDownload('model-1');
    rejectFirst(new Error('Download has been aborted'));
    await expect(firstStart).rejects.toBeInstanceOf(DownloadCancelledError);
    expect(callbacks.onError).not.toHaveBeenCalled();

    // Second attempt for the SAME model genuinely fails. The cancelled-id
    // marker from the first attempt must not swallow this real failure.
    (RNFS.downloadFile as jest.Mock).mockReturnValueOnce({
      jobId: 222,
      promise: Promise.reject(new Error('Network connection lost')),
    });

    await expect(
      iosDownloadManager.startDownload(basicModel, '/path/to/model.bin'),
    ).rejects.toThrow('Network connection lost');

    expect(callbacks.onError).toHaveBeenCalledWith(
      'model-1',
      expect.any(Error),
    );
    expect(iosDownloadManager.isDownloading('model-1')).toBe(false);
  });

  it('sends the attribution User-Agent on the iOS RNFS download', async () => {
    (Platform as any).OS = 'ios';

    const iosDownloadManager = new DownloadManager();
    iosDownloadManager.setCallbacks({
      onStart: jest.fn(),
      onProgress: jest.fn(),
      onComplete: jest.fn(),
      onError: jest.fn(),
    });

    (RNFS.downloadFile as jest.Mock).mockReturnValue({
      jobId: 999,
      promise: Promise.resolve({statusCode: 200}),
    });

    await iosDownloadManager.startDownload(basicModel, '/path/to/model.bin');

    expect(RNFS.downloadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({
          'User-Agent': 'PocketPal/1.0.0 (ai.pocketpal)',
        }),
      }),
    );
  });

  it('attaches the HF auth token only for a huggingface.co download URL (iOS)', async () => {
    (Platform as any).OS = 'ios';

    const iosDownloadManager = new DownloadManager();
    iosDownloadManager.setCallbacks({
      onStart: jest.fn(),
      onProgress: jest.fn(),
      onComplete: jest.fn(),
      onError: jest.fn(),
    });

    (RNFS.downloadFile as jest.Mock).mockReturnValue({
      jobId: 1001,
      promise: Promise.resolve({statusCode: 200}),
    });

    await iosDownloadManager.startDownload(
      hfFileModel,
      '/path/to/model.bin',
      'secret-token',
    );

    expect(RNFS.downloadFile).toHaveBeenCalledTimes(1);
    expect(RNFS.downloadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        fromUrl: hfFileModel.downloadUrl,
        headers: expect.objectContaining({
          Authorization: 'Bearer secret-token',
        }),
      }),
    );
  });

  it('does not attach the HF auth token for a non-huggingface.co URL (iOS)', async () => {
    (Platform as any).OS = 'ios';

    const iosDownloadManager = new DownloadManager();
    iosDownloadManager.setCallbacks({
      onStart: jest.fn(),
      onProgress: jest.fn(),
      onComplete: jest.fn(),
      onError: jest.fn(),
    });

    (RNFS.downloadFile as jest.Mock).mockReturnValue({
      jobId: 1002,
      promise: Promise.resolve({statusCode: 200}),
    });

    const offHostModel = {
      ...basicModel,
      id: 'off-host-model',
      downloadUrl: 'https://evil.example.com/test/test-model-1',
    };

    await iosDownloadManager.startDownload(
      offHostModel,
      '/path/to/model.bin',
      'secret-token',
    );

    const options = (RNFS.downloadFile as jest.Mock).mock.calls[0][0];
    expect(options.fromUrl).toBe(offHostModel.downloadUrl);
    expect(options.headers.Authorization).toBeUndefined();
  });

  it('does not forward the HF auth token to the native module for a non-HF URL (Android)', async () => {
    NativeModules.DownloadModule.startDownload.mockResolvedValue({
      downloadId: 'download-off-host',
    });

    const offHostModel = {
      ...basicModel,
      id: 'off-host-model',
      downloadUrl: 'https://evil.example.com/test/test-model-1',
    };

    await downloadManager.startDownload(
      offHostModel,
      '/path/to/model.bin',
      'secret-token',
    );

    expect(NativeModules.DownloadModule.startDownload).toHaveBeenCalledWith(
      offHostModel.downloadUrl,
      expect.any(Object),
    );
    const config = NativeModules.DownloadModule.startDownload.mock.calls[0][1];
    expect(config.authToken).toBeUndefined();
  });
});
