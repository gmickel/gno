"use strict";
/**
 * OCR (Optical Character Recognition) Utilities
 *
 * This module provides functions for extracting text from images using Tesseract.js.
 * Used when `config.ocr` is enabled to extract text from embedded images in documents.
 *
 * Includes a worker pool via OcrSchedulerManager to improve performance when
 * processing multiple images.
 *
 * @module ocrUtils
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.terminateOcr = exports.performOcr = void 0;
const envUtils_js_1 = require("./envUtils.js");
const errorUtils_js_1 = require("./errorUtils.js");
/**
 * Wraps a promise in a timeout.
 *
 * @param promise - The promise to wrap
 * @param ms - Timeout duration in milliseconds
 * @param errMsg - Error message to throw if timeout occurs
 * @returns The wrapped promise
 */
function withTimeout(promise, ms, errMsg) {
    let id;
    const timeout = new Promise((_, reject) => {
        id = setTimeout(() => {
            reject(new Error(errMsg));
        }, ms);
    });
    return Promise.race([promise, timeout]).then((res) => { clearTimeout(id); return res; }, (err) => { clearTimeout(id); throw err; });
}
/**
 * Manages a pool of Tesseract workers with "Smart Affinity".
 *
 * Instead of a simple scheduler, this manager allows workers to persist with
 * a specific language affinity. If a new language is requested and the pool
 * is at capacity, it re-initializes the Least Recently Used (LRU) idle worker
 * rather than resetting the entire pool.
 *
 * Implements lazy loading of tesseract.js to ensure no background processes
 * are spawned unless OCR is explicitly used.
 */
class OcrSchedulerManager {
    static instance;
    pool = [];
    queue = [];
    MAX_WORKERS = 4;
    idleTimeout = 10000; // 10s default
    timeoutId = null;
    isProcessing = false;
    constructor() { }
    /**
     * Returns the singleton instance of the manager.
     */
    static getInstance() {
        if (!OcrSchedulerManager.instance) {
            OcrSchedulerManager.instance = new OcrSchedulerManager();
        }
        return OcrSchedulerManager.instance;
    }
    /**
     * Checks if the singleton instance has been initialized.
     */
    static hasInstance() {
        return !!OcrSchedulerManager.instance;
    }
    /**
     * Resets the inactivity timer. If the timer reaches its duration,
     * all workers are terminated automatically.
     */
    resetIdleTimer() {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
        }
        if (this.idleTimeout > 0) {
            this.timeoutId = setTimeout(async () => {
                await this.terminate();
            }, this.idleTimeout);
        }
    }
    /**
     * Performs OCR on an image using the smart worker pool.
     *
     * @param image - Image data (Buffer, string path, or Blob)
     * @param config - OCR configuration (language, custom paths, timeouts, signal)
     * @returns Recognized text
     */
    async recognize(image, config) {
        const signal = config?.abortSignal;
        if (signal?.aborted) {
            return Promise.reject((0, errorUtils_js_1.getAbortError)());
        }
        return new Promise((resolve, reject) => {
            // Update idle timeout if provided.
            // Priority: timeout.autoTerminate (new) > autoTerminateTimeout (deprecated) > built-in default.
            const effectiveAutoTerminate = config?.timeout?.autoTerminate ?? config?.autoTerminateTimeout;
            if (effectiveAutoTerminate !== undefined) {
                this.idleTimeout = effectiveAutoTerminate;
            }
            // Reset the inactivity timer every time a new job is requested
            this.resetIdleTimer();
            let abortListener = null;
            let finished = false;
            let job;
            const cleanResolve = (val) => {
                if (finished)
                    return;
                finished = true;
                if (job)
                    job.isFinished = true;
                if (abortListener && signal) {
                    signal.removeEventListener('abort', abortListener);
                }
                resolve(val);
            };
            const cleanReject = (err) => {
                if (finished)
                    return;
                finished = true;
                if (job)
                    job.isFinished = true;
                if (abortListener && signal) {
                    signal.removeEventListener('abort', abortListener);
                }
                reject(err);
            };
            // Priority: timeout.recognition (new) > 30 s default.
            const recogTimeout = config?.timeout?.recognition ?? 30000;
            // Create job
            job = {
                image,
                config: config || {},
                resolve: cleanResolve,
                reject: cleanReject,
                startTime: Date.now(),
                timeoutMs: recogTimeout
            };
            if (signal) {
                abortListener = () => {
                    if (finished)
                        return;
                    const err = (0, errorUtils_js_1.getAbortError)();
                    cleanReject(err);
                    // 1. Remove job from queue if it hasn't run yet
                    const idx = this.queue.indexOf(job);
                    if (idx !== -1) {
                        this.queue.splice(idx, 1);
                    }
                    // 2. Find if any worker is currently running this job and terminate/remove it
                    const workerIndex = this.pool.findIndex(mw => mw.activeJob === job);
                    if (workerIndex !== -1) {
                        const managedWorker = this.pool[workerIndex];
                        // Remove from pool immediately to prevent reuse
                        this.pool.splice(workerIndex, 1);
                        // Terminate the worker process
                        try {
                            managedWorker.worker.terminate();
                        }
                        catch (e) { }
                        // Trigger queue processing for subsequent tasks
                        this.processQueue();
                    }
                };
                signal.addEventListener('abort', abortListener);
            }
            // Add job to queue and trigger processing
            this.queue.push(job);
            this.processQueue();
        });
    }
    /**
     * Attempts to process the next job in the queue using an available worker.
     * Designed to be race-free and support concurrent/parallel job execution.
     */
    async processQueue() {
        if (this.isProcessing)
            return;
        this.isProcessing = true;
        try {
            while (this.queue.length > 0) {
                const nextJob = this.queue[0];
                if (nextJob.isFinished) {
                    this.queue.shift();
                    continue;
                }
                const requestedLanguage = nextJob.config.language || 'eng';
                // 1. Find an idle worker with the EXACT language affinity
                let managed = this.pool.find(mw => !mw.isBusy && mw.language === requestedLanguage);
                // 2. If not found and we have room, create a new worker
                if (!managed && this.pool.length < this.MAX_WORKERS) {
                    const job = this.queue.shift();
                    if (!job)
                        continue;
                    this.createAndRunWorker(job, requestedLanguage);
                    continue;
                }
                // 3. If still not found and we are at capacity, find the LRU idle worker and re-initialize it
                if (!managed) {
                    const idleWorkers = this.pool.filter(mw => !mw.isBusy);
                    if (idleWorkers.length > 0) {
                        const job = this.queue.shift();
                        if (!job)
                            continue;
                        managed = idleWorkers.reduce((prev, curr) => (prev.lastUsed < curr.lastUsed ? prev : curr));
                        this.reinitializeAndRunWorker(managed, job, requestedLanguage);
                        continue;
                    }
                }
                // 4. If we have a worker ready, execute the job
                if (managed) {
                    const job = this.queue.shift();
                    if (!job)
                        continue;
                    this.runWorker(managed, job);
                    continue;
                }
                // No workers can be allocated right now (all busy and pool at capacity). Break work loop.
                break;
            }
        }
        finally {
            this.isProcessing = false;
        }
    }
    /**
     * Helper to dynamically instantiate a Tesseract worker, register it to the pool, and run the job.
     */
    async createAndRunWorker(job, requestedLanguage) {
        // Priority: timeout.workerLoad (new) > 60 s default.
        const loadTimeout = job.config.timeout?.workerLoad ?? 60000;
        let managed = null;
        try {
            const { createWorker } = await import('tesseract.js');
            const options = { logger: () => { } };
            if (job.config.workerPath)
                options.workerPath = job.config.workerPath;
            if (job.config.corePath)
                options.corePath = job.config.corePath;
            if (job.config.langPath)
                options.langPath = job.config.langPath;
            const workerPromise = createWorker(requestedLanguage, 1, options);
            // To prevent dangling worker threads on timeout or abort, we register a post-resolution hook
            // that terminates the worker if the promise finishes after the timeout has fired or the job is finished.
            let hasTimedOutOrAborted = false;
            workerPromise.then(async (worker) => {
                if (hasTimedOutOrAborted || job.isFinished) {
                    try {
                        await worker.terminate();
                    }
                    catch (e) { }
                }
            }, () => { });
            const worker = loadTimeout > 0
                ? await withTimeout(workerPromise, loadTimeout, `OCR worker initialization timed out after ${loadTimeout}ms`).catch(err => {
                    hasTimedOutOrAborted = true;
                    throw err;
                })
                : await workerPromise;
            // If the job finished/aborted while loading, clean up the worker and skip execution.
            if (job.isFinished) {
                hasTimedOutOrAborted = true;
                try {
                    await worker.terminate();
                }
                catch (e) { }
                this.processQueue();
                return;
            }
            managed = {
                worker,
                language: requestedLanguage,
                lastUsed: Date.now(),
                isBusy: false
            };
            this.pool.push(managed);
            await this.runWorker(managed, job);
        }
        catch (err) {
            job.reject(err);
            this.processQueue();
        }
    }
    /**
     * Helper to reinitialize an existing idle worker with a different language affinity and run the job.
     */
    async reinitializeAndRunWorker(managed, job, requestedLanguage) {
        // Priority: timeout.workerLoad (new) > 60 s default.
        const loadTimeout = job.config.timeout?.workerLoad ?? 60000;
        managed.isBusy = true;
        managed.lastUsed = Date.now();
        managed.activeJob = job;
        try {
            const reinitPromise = managed.worker.reinitialize(requestedLanguage);
            if (loadTimeout > 0) {
                await withTimeout(reinitPromise, loadTimeout, `OCR worker re-initialization timed out after ${loadTimeout}ms`);
            }
            else {
                await reinitPromise;
            }
            managed.language = requestedLanguage;
            // If the job finished/aborted while reinitializing, clean up and skip execution.
            if (job.isFinished) {
                const index = this.pool.indexOf(managed);
                if (index !== -1) {
                    this.pool.splice(index, 1);
                }
                try {
                    await managed.worker.terminate();
                }
                catch (e) { }
                this.processQueue();
                return;
            }
            await this.runWorker(managed, job);
        }
        catch (err) {
            // Re-initialization failed/timed out, remove worker from pool and terminate
            const index = this.pool.indexOf(managed);
            if (index !== -1) {
                this.pool.splice(index, 1);
            }
            try {
                await managed.worker.terminate();
            }
            catch (e) { }
            job.reject(err);
            this.processQueue();
        }
    }
    /**
     * Helper to execute OCR text recognition on the worker and return the results.
     */
    async runWorker(managed, job) {
        // Priority: timeout.recognition (new) > 30 s default.
        const recogTimeout = job.config.timeout?.recognition ?? 30000;
        managed.isBusy = true;
        managed.lastUsed = Date.now();
        managed.activeJob = job;
        try {
            const recognizePromise = managed.worker.recognize(job.image);
            const { data: { text } } = recogTimeout > 0
                ? await withTimeout(recognizePromise, recogTimeout, `OCR recognition timed out after ${recogTimeout}ms`)
                : await recognizePromise;
            job.resolve(text);
        }
        catch (err) {
            // If it timed out, terminate and remove worker to avoid reusing a stuck process
            if (err.message?.includes('timed out')) {
                const index = this.pool.indexOf(managed);
                if (index !== -1) {
                    this.pool.splice(index, 1);
                }
                try {
                    await managed.worker.terminate();
                }
                catch (e) { }
            }
            job.reject(err);
        }
        finally {
            if (this.pool.includes(managed)) {
                managed.isBusy = false;
                managed.activeJob = undefined;
                managed.lastUsed = Date.now();
            }
            this.processQueue();
        }
    }
    /**
     * Terminates all workers in the pool and resets the state.
     */
    async terminate() {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
        const workersToTerminate = this.pool.map(mw => mw.worker.terminate());
        await Promise.all(workersToTerminate);
        this.pool = [];
    }
}
/**
 * Performs Optical Character Recognition (OCR) on an image to extract text.
 *
 * Uses Tesseract.js to recognize text in the provided image buffer.
 * This is useful for extracting text from screenshots, scanned documents,
 * charts with labels, or any image containing text.
 *
 * This function uses a shared worker pool to minimize initialization overhead.
 *
 * @param image - The image data as a Buffer, file path, or Blob
 * @param config - Optional configuration for language and custom worker paths
 * @returns A promise that resolves to the recognized text as a string
 * @throws {Error} If the image cannot be processed or Tesseract initialization fails
 *
 * @example
 * ```typescript
 * // Extract text from an English image
 * const text = await performOcr(imageBuffer, { language: 'eng' });
 * ```
 *
 * @see https://github.com/naptha/tesseract.js for supported languages and options
 */
const performOcr = async (image, config) => {
    // Prepare image data
    let inputImage = image;
    // In browser environment, convert Buffer to Blob for better compatibility
    // @ts-ignore
    if (envUtils_js_1.isBrowser && typeof Blob !== 'undefined' && Buffer.isBuffer(image)) {
        inputImage = new Blob([image], { type: 'image/bmp' });
    }
    return await OcrSchedulerManager.getInstance().recognize(inputImage, config);
};
exports.performOcr = performOcr;
/**
 * Terminates all OCR workers and cleans up resources.
 *
 * Should be called when the application is shutting down or OCR is no longer needed
 * to prevent memory leaks and dangling worker processes.
 */
const terminateOcr = async () => {
    if (OcrSchedulerManager.hasInstance()) {
        await OcrSchedulerManager.getInstance().terminate();
    }
};
exports.terminateOcr = terminateOcr;
