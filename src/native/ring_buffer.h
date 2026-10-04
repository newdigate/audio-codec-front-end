#pragma once
#include <vector>
#include <atomic>
#include <cstddef>
#include <algorithm>

namespace audio_front_end {

template <typename T>
class SpscRingBuffer {
public:
    explicit SpscRingBuffer(size_t capacity)
        : capacity_(capacity), buffer_(capacity), head_(0), tail_(0) {}

    size_t write(const T* data, size_t count) {
        size_t head = head_.load(std::memory_order_relaxed);
        size_t tail = tail_.load(std::memory_order_acquire);
        size_t available = (tail > head) ? (tail - head - 1) : (capacity_ - head + tail - 1);
        size_t toWrite = std::min(count, available);

        for (size_t i = 0; i < toWrite; ++i) {
            buffer_[head] = data[i];
            head = (head + 1) % capacity_;
        }
        head_.store(head, std::memory_order_release);
        return toWrite;
    }

    size_t read(T* outData, size_t count) {
        size_t head = head_.load(std::memory_order_acquire);
        size_t tail = tail_.load(std::memory_order_relaxed);
        size_t available = (head >= tail) ? (head - tail) : (capacity_ - tail + head);
        size_t toRead = std::min(count, available);

        for (size_t i = 0; i < toRead; ++i) {
            outData[i] = buffer_[tail];
            tail = (tail + 1) % capacity_;
        }
        tail_.store(tail, std::memory_order_release);
        return toRead;
    }

    void clear() {
        head_.store(0, std::memory_order_relaxed);
        tail_.store(0, std::memory_order_relaxed);
    }

    // Consumer-only safe buffer drain
    void discardAll() {
        size_t head = head_.load(std::memory_order_acquire);
        tail_.store(head, std::memory_order_release);
    }

    size_t availableRead() const {
        size_t head = head_.load(std::memory_order_acquire);
        size_t tail = tail_.load(std::memory_order_relaxed);
        return (head >= tail) ? (head - tail) : (capacity_ - tail + head);
    }

    size_t availableWrite() const {
        size_t head = head_.load(std::memory_order_relaxed);
        size_t tail = tail_.load(std::memory_order_acquire);
        return (tail > head) ? (tail - head - 1) : (capacity_ - head + tail - 1);
    }

    size_t capacity() const {
        return capacity_;
    }

private:
    size_t capacity_;
    std::vector<T> buffer_;
    std::atomic<size_t> head_;
    std::atomic<size_t> tail_;
};

} // namespace audio_front_end
