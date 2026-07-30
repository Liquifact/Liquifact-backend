'use strict';

const shutdownCoordinator = require('../src/utils/shutdownCoordinator');
const logger = require('../src/logger');
const db = require('../src/db/knex');

describe('Graceful Shutdown Coordinator', () => {
  let mockServer;
  let mockWorker;
  let originalExit;
  let originalEnv;
  let exitSpy;
  let loggerInfoSpy;
  let loggerWarnSpy;
  let loggerErrorSpy;

  beforeEach(() => {
    // Reset coordinator state
    shutdownCoordinator._resetState();

    // Mock process.exit
    originalExit = process.exit;
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});

    // Save environment
    originalEnv = { ...process.env };

    // Spy on logger
    loggerInfoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});
    loggerWarnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    loggerErrorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});

    // Mock server
    mockServer = {
      close: jest.fn((cb) => cb()),
      closeIdleConnections: jest.fn(),
    };

    // Mock worker
    mockWorker = {
      stop: jest.fn().mockResolvedValue(),
    };

    // Mock knex db.destroy if not present
    if (typeof db.destroy !== 'function') {
      db.destroy = jest.fn().mockResolvedValue();
    } else {
      jest.spyOn(db, 'destroy').mockResolvedValue();
    }
  });

  afterEach(() => {
    // Restore process.exit and environment
    process.exit = originalExit;
    process.env = originalEnv;

    // Restore logger spies
    loggerInfoSpy.mockRestore();
    loggerWarnSpy.mockRestore();
    loggerErrorSpy.mockRestore();

    if (typeof db.destroy.mockRestore === 'function') {
      db.destroy.mockRestore();
    }
  });

  test('should register server and worker and execute shutdown in the correct order', async () => {
    const order = [];

    mockServer.closeIdleConnections.mockImplementation(() => {
      order.push('closeIdleConnections');
    });

    mockServer.close.mockImplementation((cb) => {
      order.push('server.close');
      cb();
    });

    mockWorker.stop.mockImplementation(() => {
      order.push('worker.stop');
      return Promise.resolve();
    });

    jest.spyOn(db, 'destroy').mockImplementation(() => {
      order.push('db.destroy');
      return Promise.resolve();
    });

    shutdownCoordinator.register({ server: mockServer, worker: mockWorker });
    await shutdownCoordinator.executeShutdown('SIGTERM');

    expect(order).toEqual([
      'closeIdleConnections',
      'server.close',
      'worker.stop',
      'db.destroy',
    ]);
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.any(Object),
      expect.stringContaining('Graceful shutdown completed successfully')
    );
  });

  test('should execute shutdown only once and ignore duplicate signals/calls', async () => {
    shutdownCoordinator.register({ server: mockServer, worker: mockWorker });

    // Call executeShutdown twice sequentially
    await shutdownCoordinator.executeShutdown('SIGTERM');
    await shutdownCoordinator.executeShutdown('SIGINT');

    // Server close should only be called once
    expect(mockServer.close).toHaveBeenCalledTimes(1);
    expect(mockWorker.stop).toHaveBeenCalledTimes(1);
    expect(db.destroy).toHaveBeenCalledTimes(1);

    // Verify warning or info log about duplicate shutdown
    expect(loggerInfoSpy).toHaveBeenCalledWith(
      { reason: 'SIGINT' },
      '[shutdown] Shutdown already in progress. Ignoring duplicate request.'
    );
  });

  test('should support configurable shutdown timeout (SHUTDOWN_TIMEOUT_MS)', async () => {
    // Set a very short timeout
    process.env.SHUTDOWN_TIMEOUT_MS = '10';

    // Mock a worker that hangs forever
    mockWorker.stop.mockImplementation(() => new Promise(() => {}));

    shutdownCoordinator.register({ server: mockServer, worker: mockWorker });

    // Use fake timers to fast-forward
    jest.useFakeTimers();

    const shutdownPromise = shutdownCoordinator.executeShutdown('SIGTERM');

    // Fast-forward timers to trigger the force-exit timeout
    jest.advanceTimersByTime(20);

    await shutdownPromise;

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      { timeoutMs: 10 },
      '[shutdown] Graceful shutdown timed out; forcing exit.'
    );

    jest.useRealTimers();
  });

  test('should respect SIGTERM and SIGINT signals in non-test mode', () => {
    // Override NODE_ENV to simulate production
    process.env.NODE_ENV = 'production';

    const processOnSpy = jest.spyOn(process, 'on').mockImplementation(() => {});

    shutdownCoordinator.setupSignalListeners();

    expect(processOnSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(processOnSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));

    processOnSpy.mockRestore();
  });

  test('should not register signal listeners in test mode (NODE_ENV=test)', () => {
    process.env.NODE_ENV = 'test';
    const processOnSpy = jest.spyOn(process, 'on');

    shutdownCoordinator.setupSignalListeners();

    expect(processOnSpy).not.toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(processOnSpy).not.toHaveBeenCalledWith('SIGINT', expect.any(Function));

    processOnSpy.mockRestore();
  });

  test('should handle shutdown cleanly even if some components are missing', async () => {
    // Register nothing
    shutdownCoordinator.register({});

    await shutdownCoordinator.executeShutdown('SIGTERM');

    // Knex destroy should still be called because it is required from src/db/knex.js
    expect(db.destroy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test('should exit with 1 and log error if any step in shutdown throws', async () => {
    const error = new Error('Database destroy failed');
    jest.spyOn(db, 'destroy').mockRejectedValue(error);

    shutdownCoordinator.register({ server: mockServer });
    await shutdownCoordinator.executeShutdown('SIGTERM');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      { err: error },
      '[shutdown] Error occurred during graceful shutdown'
    );
  });
});
