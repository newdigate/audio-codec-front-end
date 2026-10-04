#include <napi.h>
#include <filesystem>
#include <algorithm>
#include <vector>
#include <string>
#include <iostream>
#include "batch_worker_pool.h"
#include "analysis_cache.h"

namespace {

audio_front_end::BatchWorkerPool g_pool;

Napi::String GetVersion(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    return Napi::String::New(env, "0.1.0");
}

Napi::Value ScanFolder(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "String expected for folderPath").ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string folderPath = info[0].As<Napi::String>().Utf8Value();
    Napi::Array results = Napi::Array::New(env);

    namespace fs = std::filesystem;
    std::error_code ec;
    if (!fs::exists(folderPath, ec) || !fs::is_directory(folderPath, ec)) {
        return results;
    }

    audio_front_end::AnalysisCache cache;
    uint32_t idx = 0;

    auto it = fs::recursive_directory_iterator(folderPath, fs::directory_options::skip_permission_denied, ec);
    auto end = fs::recursive_directory_iterator();
    while (it != end) {
        if (ec) break;
        const auto& entry = *it;
        std::string filename = entry.path().filename().string();
        if (!filename.empty() && filename.front() == '.') {
            if (entry.is_directory(ec)) {
                it.disable_recursion_pending();
            }
            it.increment(ec);
            continue;
        }

        if (entry.is_regular_file(ec)) {
            std::string ext = entry.path().extension().string();
            std::transform(ext.begin(), ext.end(), ext.begin(), ::tolower);
            if (ext == ".wav" || ext == ".wave" || ext == ".aiff" || ext == ".aif" ||
                ext == ".mp3" || ext == ".flac" || ext == ".ogg" || ext == ".oga" ||
                ext == ".aac" || ext == ".m4a") {

                std::string filePath = fs::absolute(entry.path(), ec).string();
                uint64_t sizeBytes = entry.file_size(ec);

                std::string status = "pending";
                uint32_t durationMs = 0;
                double bpm = 0.0;

                if (cache.HasValidCache(filePath, false)) {
                    status = "cached";
                    audio_front_end::CachedAnalysisData data;
                    if (cache.ReadCache(filePath, data, false)) {
                        durationMs = data.durationMs;
                        bpm = data.bpm;
                    }
                } else if (cache.HasValidCache(filePath, true)) {
                    status = "cached";
                    audio_front_end::CachedAnalysisData data;
                    if (cache.ReadCache(filePath, data, true)) {
                        durationMs = data.durationMs;
                        bpm = data.bpm;
                    }
                }

                Napi::Object fileObj = Napi::Object::New(env);
                fileObj.Set("filePath", Napi::String::New(env, filePath));
                fileObj.Set("fileName", Napi::String::New(env, filename));
                fileObj.Set("sizeBytes", Napi::Number::New(env, static_cast<double>(sizeBytes)));
                fileObj.Set("status", Napi::String::New(env, status));
                fileObj.Set("durationMs", Napi::Number::New(env, durationMs));
                fileObj.Set("bpm", Napi::Number::New(env, bpm));

                results.Set(idx++, fileObj);
            }
        }
        it.increment(ec);
    }

    return results;
}

Napi::Value StartBatchAnalysis(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2) {
        Napi::TypeError::New(env, "Expected at least 2 arguments (target, callback)").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::vector<std::string> files;
    bool flatSidecar = false;
    Napi::Function callback;

    if (info[0].IsString()) {
        std::string folderPath = info[0].As<Napi::String>().Utf8Value();
        namespace fs = std::filesystem;
        std::error_code ec;
        if (fs::exists(folderPath, ec) && fs::is_directory(folderPath, ec)) {
            auto it = fs::recursive_directory_iterator(folderPath, fs::directory_options::skip_permission_denied, ec);
            auto end = fs::recursive_directory_iterator();
            while (it != end) {
                if (ec) break;
                const auto& entry = *it;
                std::string fn = entry.path().filename().string();
                if (!fn.empty() && fn.front() == '.') {
                    if (entry.is_directory(ec)) it.disable_recursion_pending();
                    it.increment(ec);
                    continue;
                }
                if (entry.is_regular_file(ec)) {
                    std::string ext = entry.path().extension().string();
                    std::transform(ext.begin(), ext.end(), ext.begin(), ::tolower);
                    if (ext == ".wav" || ext == ".wave" || ext == ".aiff" || ext == ".aif" ||
                        ext == ".mp3" || ext == ".flac" || ext == ".ogg" || ext == ".oga" ||
                        ext == ".aac" || ext == ".m4a") {
                        files.push_back(fs::absolute(entry.path(), ec).string());
                    }
                }
                it.increment(ec);
            }
        }
    } else if (info[0].IsArray()) {
        Napi::Array arr = info[0].As<Napi::Array>();
        for (uint32_t i = 0; i < arr.Length(); ++i) {
            Napi::Value val = arr.Get(i);
            if (val.IsString()) {
                files.push_back(val.As<Napi::String>().Utf8Value());
            }
        }
    } else {
        Napi::TypeError::New(env, "Expected folder path or array of file paths as first argument").ThrowAsJavaScriptException();
        return env.Null();
    }

    if (info.Length() >= 3 && info[2].IsFunction()) {
        flatSidecar = info[1].ToBoolean().Value();
        callback = info[2].As<Napi::Function>();
    } else if (info[1].IsFunction()) {
        flatSidecar = false;
        callback = info[1].As<Napi::Function>();
    } else {
        Napi::TypeError::New(env, "Callback function expected").ThrowAsJavaScriptException();
        return env.Null();
    }

    unsigned int hw = std::thread::hardware_concurrency();
    if (hw == 0) hw = 4;
    size_t numThreads = std::min<size_t>(hw, std::max<size_t>(1, files.size()));

    Napi::ThreadSafeFunction tsfn = Napi::ThreadSafeFunction::New(
        env,
        callback,
        "BatchWorkerPoolCallback",
        0,
        numThreads
    );

    g_pool.StartBatch(files, flatSidecar, tsfn);
    return env.Undefined();
}

Napi::Value ControlBatchAnalysis(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "String expected for action ('pause', 'resume', 'cancel')").ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string action = info[0].As<Napi::String>().Utf8Value();
    if (action == "pause") {
        g_pool.Pause();
        return Napi::Boolean::New(env, true);
    } else if (action == "resume") {
        g_pool.Resume();
        return Napi::Boolean::New(env, true);
    } else if (action == "cancel") {
        g_pool.Cancel();
        return Napi::Boolean::New(env, true);
    }
    return Napi::Boolean::New(env, false);
}

Napi::Value LoadFileAnalysis(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "String expected for filePath").ThrowAsJavaScriptException();
        return env.Null();
    }
    std::string filePath = info[0].As<Napi::String>().Utf8Value();
    bool flatSidecar = false;
    if (info.Length() >= 2 && info[1].IsBoolean()) {
        flatSidecar = info[1].As<Napi::Boolean>().Value();
    }

    audio_front_end::AnalysisCache cache;
    audio_front_end::CachedAnalysisData data;
    if (!cache.ReadCache(filePath, data, flatSidecar)) {
        return env.Null();
    }

    Napi::Object result = Napi::Object::New(env);
    result.Set("durationMs", Napi::Number::New(env, data.durationMs));
    result.Set("sampleRate", Napi::Number::New(env, data.sampleRate));
    result.Set("channels", Napi::Number::New(env, data.channels));
    result.Set("bpm", Napi::Number::New(env, data.bpm));
    result.Set("confidence", Napi::Number::New(env, data.confidence));

    Napi::Array timeSig = Napi::Array::New(env, 2);
    timeSig.Set(static_cast<uint32_t>(0), Napi::Number::New(env, data.timeSignature.first));
    timeSig.Set(static_cast<uint32_t>(1), Napi::Number::New(env, data.timeSignature.second));
    result.Set("timeSignature", timeSig);

    Napi::Array lodsArr = Napi::Array::New(env, data.lods.size());
    for (size_t i = 0; i < data.lods.size(); ++i) {
        const auto& lod = data.lods[i];
        Napi::Object lodObj = Napi::Object::New(env);
        lodObj.Set("downsampleRatio", Napi::Number::New(env, lod.downsampleRatio));
        lodObj.Set("chunkCount", Napi::Number::New(env, lod.chunkCount));

        Napi::ArrayBuffer ab = Napi::ArrayBuffer::New(env, lod.peaks.size());
        if (!lod.peaks.empty()) {
            std::memcpy(ab.Data(), lod.peaks.data(), lod.peaks.size());
        }
        Napi::Int8Array int8Arr = Napi::Int8Array::New(env, lod.peaks.size(), ab, 0);
        lodObj.Set("peaks", int8Arr);
        lodObj.Set("buffer", ab);

        lodsArr.Set(static_cast<uint32_t>(i), lodObj);
    }
    result.Set("lods", lodsArr);

    Napi::Array beatsArr = Napi::Array::New(env, data.beats.size());
    for (size_t i = 0; i < data.beats.size(); ++i) {
        const auto& b = data.beats[i];
        Napi::Object beatObj = Napi::Object::New(env);
        beatObj.Set("timeMs", Napi::Number::New(env, b.timeMs));
        beatObj.Set("barIndex", Napi::Number::New(env, b.barIndex));
        beatObj.Set("beatWithinBar", Napi::Number::New(env, b.beatWithinBar));
        beatObj.Set("isDownbeat", Napi::Boolean::New(env, b.isDownbeat));
        beatObj.Set("localBpm", Napi::Number::New(env, b.localBpm));

        beatsArr.Set(static_cast<uint32_t>(i), beatObj);
    }
    result.Set("beats", beatsArr);

    return result;
}

} // anonymous namespace

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("getVersion", Napi::Function::New(env, GetVersion));
    exports.Set("scanFolder", Napi::Function::New(env, ScanFolder));
    exports.Set("startBatchAnalysis", Napi::Function::New(env, StartBatchAnalysis));
    exports.Set("controlBatchAnalysis", Napi::Function::New(env, ControlBatchAnalysis));
    exports.Set("loadFileAnalysis", Napi::Function::New(env, LoadFileAnalysis));
    return exports;
}

NODE_API_MODULE(audio_native, Init)
