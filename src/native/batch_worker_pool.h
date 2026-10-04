#pragma once
#include <vector>
#include <string>
#include <thread>
#include <queue>
#include <mutex>
#include <condition_variable>
#include <atomic>
#include <memory>
#include <napi.h>
#include "analysis_cache.h"

namespace audio_front_end {

struct BatchJob {
    std::string filePath;
    bool flatSidecar;
};

struct ProgressUpdate {
    std::string filePath;
    double progressPct{0.0};
    double bpm{0.0};
    std::string status;
    uint32_t durationMs{0};
};

class BatchWorkerPool {
public:
    BatchWorkerPool();
    ~BatchWorkerPool();

    void StartBatch(const std::vector<std::string>& files, bool flatSidecar, Napi::ThreadSafeFunction tsfn);
    void Pause();
    void Resume();
    void Cancel();
    bool IsRunning() const;

private:
    void WorkerLoop();
    void ProcessFile(const std::string& filePath, bool flatSidecar);
    void JoinWorkers();
    void NotifyProgress(const ProgressUpdate& update);

    std::vector<std::thread> workers_;
    std::queue<BatchJob> queue_;
    std::mutex queueMutex_;
    std::condition_variable cv_;
    std::atomic<bool> stop_{false};
    std::atomic<bool> paused_{false};
    std::atomic<size_t> remainingJobs_{0};
    Napi::ThreadSafeFunction progressCallback_;
    AnalysisCache cache_;
};

} // namespace audio_front_end
