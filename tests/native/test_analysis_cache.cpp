#include <cassert>
#include <iostream>
#include <fstream>
#include <filesystem>
#include "analysis_cache.h"

namespace fs = std::filesystem;

void test_basic_cache_workflow() {
    fs::path tempDir = fs::temp_directory_path() / "test_audio_cache_basic";
    fs::create_directories(tempDir);
    fs::path sampleAudio = tempDir / "test.wav";
    {
        std::ofstream f(sampleAudio, std::ios::binary);
        f.write("RIFFtestdata", 12);
    }

    audio_front_end::AnalysisCache cache;
    
    // 1. Initial check - should be unanalyzed
    assert(!cache.HasValidCache(sampleAudio.string(), false));

    // 2. Generate dummy apv and att
    audio_codecs::preview::ApvHeader apv{};
    apv.source_file_size = 12;
    apv.duration_ms = 1000;
    apv.sample_rate = 44100;
    apv.channels = 2;

    audio_codecs::tempo::AttHeader att{};
    att.duration_ms = 1000;
    att.global_bpm_q16 = 120 << 16;

    assert(cache.WriteCache(sampleAudio.string(), apv, {}, att, {}, false));

    // 3. Cache should now be valid
    assert(cache.HasValidCache(sampleAudio.string(), false));

    // 4. Test reading cache
    audio_front_end::CachedAnalysisData data;
    assert(cache.ReadCache(sampleAudio.string(), data, false));
    assert(data.durationMs == 1000);
    assert(data.sampleRate == 44100);
    assert(data.bpm == 120.0);

    fs::remove_all(tempDir);
    std::cout << "test_basic_cache_workflow PASSED" << std::endl;
}

void test_path_resolution() {
    std::string audio = "/path/to/track.wav";
    auto apvDefault = audio_front_end::AnalysisCache::GetApvPath(audio, false);
    auto attDefault = audio_front_end::AnalysisCache::GetAttPath(audio, false);
    assert(apvDefault == "/path/to/.analysis/track.wav.apv");
    assert(attDefault == "/path/to/.analysis/track.wav.att");

    auto apvFlat = audio_front_end::AnalysisCache::GetApvPath(audio, true);
    auto attFlat = audio_front_end::AnalysisCache::GetAttPath(audio, true);
    assert(apvFlat == "/path/to/track.wav.apv");
    assert(attFlat == "/path/to/track.wav.att");

    std::cout << "test_path_resolution PASSED" << std::endl;
}

void test_flat_sidecar_and_invalidation() {
    fs::path tempDir = fs::temp_directory_path() / "test_audio_cache_flat";
    fs::create_directories(tempDir);
    fs::path sampleAudio = tempDir / "beat.wav";
    {
        std::ofstream f(sampleAudio, std::ios::binary);
        f.write("1234567890", 10);
    }

    audio_front_end::AnalysisCache cache;
    assert(!cache.HasValidCache(sampleAudio.string(), true));

    audio_codecs::preview::ApvHeader apv{};
    apv.source_file_size = 10;
    apv.duration_ms = 2500;
    apv.sample_rate = 48000;
    apv.channels = 2;

    audio_codecs::tempo::AttHeader att{};
    att.duration_ms = 2500;
    att.global_bpm_q16 = static_cast<uint32_t>(128.5 * 65536.0);
    att.time_signature_num = 3;
    att.time_signature_denom = 4;
    att.confidence = 95;

    // Write dummy LODs
    std::vector<std::vector<int8_t>> lods(2);
    // LOD 0: 2 chunks (each 4 bytes stereo)
    lods[0] = { -50, 60, -40, 55,  -70, 80, -65, 75 };
    // LOD 1: 1 chunk
    lods[1] = { -70, 80, -65, 75 };

    // Write dummy Beat markers
    std::vector<audio_codecs::tempo::AttBeatMarker> beats(2);
    beats[0].time_ms = 0;
    beats[0].bar_index = 0;
    beats[0].beat_within_bar = 0;
    beats[0].flags = audio_codecs::tempo::ATT_BEAT_FLAG_DOWNBEAT;
    beats[0].local_bpm_q16 = static_cast<uint32_t>(128.5 * 65536.0);

    beats[1].time_ms = 467;
    beats[1].bar_index = 0;
    beats[1].beat_within_bar = 1;
    beats[1].flags = 0;
    beats[1].local_bpm_q16 = static_cast<uint32_t>(128.5 * 65536.0);

    assert(cache.WriteCache(sampleAudio.string(), apv, lods, att, beats, true));

    // Verify flat files were created
    assert(fs::exists(tempDir / "beat.wav.apv"));
    assert(fs::exists(tempDir / "beat.wav.att"));
    assert(cache.HasValidCache(sampleAudio.string(), true));

    // Read and verify data
    audio_front_end::CachedAnalysisData data;
    assert(cache.ReadCache(sampleAudio.string(), data, true));
    assert(data.durationMs == 2500);
    assert(data.sampleRate == 48000);
    assert(std::abs(data.bpm - 128.5) < 0.01);
    assert(data.confidence == 95);
    assert(data.timeSignature.first == 3);
    assert(data.timeSignature.second == 4);

    // Verify LODs
    assert(data.lods.size() == 2);
    assert(data.lods[0].chunkCount == 2);
    assert(data.lods[0].peaks == lods[0]);
    assert(data.lods[1].chunkCount == 1);
    assert(data.lods[1].peaks == lods[1]);

    // Verify beats
    assert(data.beats.size() == 2);
    assert(data.beats[0].timeMs == 0);
    assert(data.beats[0].isDownbeat == true);
    assert(data.beats[1].timeMs == 467);
    assert(data.beats[1].isDownbeat == false);

    // Test cache invalidation when audio size changes
    {
        std::ofstream f(sampleAudio, std::ios::binary | std::ios::app);
        f.write("EXTRA_BYTES", 11);
    }
    // Now audio size is 21 != 10
    assert(!cache.HasValidCache(sampleAudio.string(), true));

    fs::remove_all(tempDir);
    std::cout << "test_flat_sidecar_and_invalidation PASSED" << std::endl;
}

int main() {
    test_path_resolution();
    test_basic_cache_workflow();
    test_flat_sidecar_and_invalidation();
    std::cout << "test_analysis_cache PASSED" << std::endl;
    return 0;
}
