'use strict';

function loadIndexWithWorkers(firstJob, secondJob, shutdownCoordinator = { register: jest.fn() }) {
  jest.resetModules();
  jest.doMock('./app', () => ({ listen: jest.fn(), createApp: jest.fn() }));
  jest.doMock('./jobs/idempotencyPurge', () => firstJob);
  jest.doMock('./jobs/invoiceStatePurge', () => secondJob);
  jest.doMock('./utils/shutdownCoordinator', () => shutdownCoordinator);
  return { index: require('./index'), shutdownCoordinator };
}

afterEach(() => {
  jest.dontMock('./app');
  jest.dontMock('./jobs/idempotencyPurge');
  jest.dontMock('./jobs/invoiceStatePurge');
  jest.dontMock('./utils/shutdownCoordinator');
  jest.resetModules();
});

describe('entry-point background worker startup', () => {
  test('coalesces concurrent startup calls and registers workers once', async () => {
    let resolveFirstStart;
    const firstStart = jest.fn(() => new Promise((resolve) => {
      resolveFirstStart = resolve;
    }));
    const firstJob = {
      startPurgeWorker: firstStart,
      stopPurgeWorker: jest.fn(),
      purgeWorker: {},
    };
    const secondJob = {
      startPurgeWorker: jest.fn().mockResolvedValue(undefined),
      stopPurgeWorker: jest.fn(),
      purgeWorker: {},
    };
    const { index, shutdownCoordinator } = loadIndexWithWorkers(firstJob, secondJob);

    const initialAttempt = index.startBackgroundWorkers();
    const duplicateAttempt = index.startBackgroundWorkers();
    expect(duplicateAttempt).toBe(initialAttempt);

    resolveFirstStart();
    await Promise.all([initialAttempt, duplicateAttempt]);

    expect(firstStart).toHaveBeenCalledTimes(1);
    expect(secondJob.startPurgeWorker).toHaveBeenCalledTimes(1);
    expect(shutdownCoordinator.register).toHaveBeenCalledTimes(2);
  });

  test('rolls back a partial start and permits a later retry', async () => {
    const firstJob = {
      startPurgeWorker: jest.fn().mockResolvedValue(undefined),
      stopPurgeWorker: jest.fn().mockResolvedValue(undefined),
      purgeWorker: {},
    };
    const secondJob = {
      startPurgeWorker: jest.fn()
        .mockRejectedValueOnce(new Error('recovery dependency unavailable'))
        .mockResolvedValueOnce(undefined),
      stopPurgeWorker: jest.fn(),
      purgeWorker: {},
    };
    const { index, shutdownCoordinator } = loadIndexWithWorkers(firstJob, secondJob);

    await expect(index.startBackgroundWorkers()).rejects.toThrow('recovery dependency unavailable');
    expect(firstJob.stopPurgeWorker).toHaveBeenCalledTimes(1);
    expect(shutdownCoordinator.register).not.toHaveBeenCalled();

    await expect(index.startBackgroundWorkers()).resolves.toBeUndefined();
    expect(firstJob.startPurgeWorker).toHaveBeenCalledTimes(2);
    expect(secondJob.startPurgeWorker).toHaveBeenCalledTimes(2);
    expect(shutdownCoordinator.register).toHaveBeenCalledTimes(2);
  });
});