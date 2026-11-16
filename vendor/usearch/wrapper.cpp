#include "source/c/usearch.h"
#include <emscripten/emscripten.h>
#include <cstdlib>
#include <vector>
#include <algorithm>
#include <cstring>

static usearch_index_t index_handle = nullptr;
static usearch_error_t last_error = nullptr;
static std::vector<usearch_key_t> keys;
static std::vector<usearch_distance_t> distances;
extern "C" {
EMSCRIPTEN_KEEPALIVE const char *ul_error() { return last_error ? last_error : ""; }
EMSCRIPTEN_KEEPALIVE int ul_open(int dimensions, int quantization, int connectivity, int expansion_add, int metric) {
  last_error = nullptr;
  usearch_init_options_t options = {};
  options.metric_kind = (usearch_metric_kind_t)metric;
  options.quantization = (usearch_scalar_kind_t)quantization;
  options.dimensions = dimensions;
  options.connectivity = connectivity;
  options.expansion_add = expansion_add;
  options.expansion_search = 200;
  options.multi = false;
  index_handle = usearch_init(&options, &last_error);
  return last_error || !index_handle;
}
EMSCRIPTEN_KEEPALIVE int ul_reserve(int capacity) { last_error = nullptr; usearch_reserve(index_handle, capacity, &last_error); return last_error != nullptr; }
EMSCRIPTEN_KEEPALIVE int ul_add(int id, const float *vector) { last_error = nullptr; usearch_add(index_handle, (usearch_key_t)id, vector, usearch_scalar_f32_k, &last_error); return last_error != nullptr; }
EMSCRIPTEN_KEEPALIVE int ul_remove(int id) { last_error = nullptr; size_t n = usearch_remove(index_handle, (usearch_key_t)id, &last_error); return last_error ? -1 : (int)n; }
EMSCRIPTEN_KEEPALIVE int ul_search(const float *query, int limit, int expansion) {
  if (limit < 1 || limit > 10000) { last_error = "Invalid result limit"; return -1; }
  keys.resize(limit); distances.resize(limit);
  last_error = nullptr; usearch_change_expansion_search(index_handle, expansion, &last_error); if (last_error) return -1;
  size_t n = usearch_search(index_handle, query, usearch_scalar_f32_k, limit, keys.data(), distances.data(), &last_error);
  return last_error ? -1 : (int)n;
}
EMSCRIPTEN_KEEPALIVE float ul_distance(int i) { return distances[i]; }
EMSCRIPTEN_KEEPALIVE int ul_key(int i) { return (int)keys[i]; }
EMSCRIPTEN_KEEPALIVE int ul_count() { last_error = nullptr; return (int)usearch_size(index_handle, &last_error); }
EMSCRIPTEN_KEEPALIVE int ul_memory() { last_error = nullptr; return (int)usearch_memory_usage(index_handle, &last_error); }
EMSCRIPTEN_KEEPALIVE int ul_size() { last_error = nullptr; return (int)usearch_serialized_length(index_handle, &last_error); }
EMSCRIPTEN_KEEPALIVE int ul_save(void *buffer, int size) { last_error = nullptr; usearch_save_buffer(index_handle, buffer, size, &last_error); return last_error != nullptr; }
EMSCRIPTEN_KEEPALIVE int ul_load(const void *buffer, int size) { last_error = nullptr; usearch_load_buffer(index_handle, buffer, size, &last_error); return last_error != nullptr; }
EMSCRIPTEN_KEEPALIVE int ul_snapshot_scalar(const void *buffer, int size) { last_error = nullptr; usearch_init_options_t o = {}; usearch_metadata_buffer(buffer, size, &o, &last_error); return last_error ? -1 : (int)o.quantization; }
EMSCRIPTEN_KEEPALIVE int ul_snapshot_metric(const void *buffer, int size) { last_error = nullptr; usearch_init_options_t o = {}; usearch_metadata_buffer(buffer, size, &o, &last_error); return last_error ? -1 : (int)o.metric_kind; }
EMSCRIPTEN_KEEPALIVE const char *ul_version() { return usearch_version(); }
EMSCRIPTEN_KEEPALIVE const char *ul_acceleration() { last_error = nullptr; return usearch_hardware_acceleration(index_handle, &last_error); }
EMSCRIPTEN_KEEPALIVE void ul_close() { if (index_handle) { last_error = nullptr; usearch_free(index_handle, &last_error); index_handle = nullptr; } }
}


#include <usearch/index_dense.hpp>
extern "C" {
EMSCRIPTEN_KEEPALIVE int ul_filtered_search(const float *query, int limit, const unsigned int *allowed, int allowed_count, int exact) {
  last_error = nullptr;
  if (limit < 1 || limit > 10000 || allowed_count < 0) { last_error = "Invalid search scope"; return -1; }
  keys.resize(limit); distances.resize(limit);
  auto *dense = reinterpret_cast<unum::usearch::index_dense_t*>(index_handle);
  auto result = dense->filtered_search(query, limit, [allowed, allowed_count](usearch_key_t key) {
    return key <= UINT32_MAX && std::binary_search(allowed, allowed + allowed_count, (unsigned int)key);
  }, unum::usearch::index_dense_t::any_thread(), exact != 0);
  if (!result) { last_error = result.error.release(); return -1; }
  return (int)result.dump_to(keys.data(), distances.data(), limit);
}
// Visit the canonical serializer, copying only one requested output interval.
// Queries can run between calls; mutations must stay frozen for the whole save.
EMSCRIPTEN_KEEPALIVE int ul_save_slice(unsigned int offset, unsigned char *destination, unsigned int capacity) {
  last_error = nullptr; size_t cursor = 0, copied = 0; bool filled = false;
  auto result = reinterpret_cast<unum::usearch::index_dense_t*>(index_handle)->save_to_stream(
    [&](void const *source, size_t length) {
      size_t begin = cursor; cursor += length;
      if (cursor > offset && copied < capacity) {
        size_t skip = offset > begin ? offset - begin : 0;
        size_t take = (std::min)(length - skip, (size_t)capacity - copied);
        std::memcpy(destination + copied, (unsigned char const*)source + skip, take); copied += take;
      }
      if (copied == capacity) { filled = true; return false; } return true;
    });
  if (!result) { auto error = result.error.release(); if (!filled) { last_error = error; return -1; } }
  return (int)copied;
}
}
EM_JS(int, ul_copy_snapshot, (void *destination, unsigned int length), {
  const source = Module.restoreSource, offset = Module.restoreOffset || 0;
  if (!source || length > source.length - offset) return 0;
  HEAPU8.set(source.subarray(offset, offset + length), destination);
  Module.restoreOffset = offset + length;
  return 1;
});
extern "C" {
EMSCRIPTEN_KEEPALIVE int ul_validate_identity(int dimensions, int scalar, int metric) {
  using namespace unum::usearch;
  auto *dense = reinterpret_cast<index_dense_t*>(index_handle);
  last_error = nullptr;
  if (!dense || dense->dimensions() != (std::size_t)dimensions ||
      dense->scalar_kind() != (scalar == 1 ? scalar_kind_t::f32_k : scalar_kind_t::i8_k) ||
      dense->metric().metric_kind() != (metric == 1 ? metric_kind_t::cos_k : metric_kind_t::ip_k)) {
    last_error = "Restored index dimensions/scalar/metric mismatch";
    return 1;
  }
  return 0;
}
EMSCRIPTEN_KEEPALIVE int ul_load_js() {
  last_error = nullptr;
  auto result = reinterpret_cast<unum::usearch::index_dense_t*>(index_handle)->load_from_stream(
    [](void *destination, std::size_t length) { return ul_copy_snapshot(destination, length) != 0; });
  if (!result) { last_error = result.error.release(); return 1; }
  return 0;
}
}

#include <malloc.h>
#include <unistd.h>
extern "C" {
EMSCRIPTEN_KEEPALIVE int ul_arena_cap() { return VECTOR_ARENA_CAP_MIB; }
EMSCRIPTEN_KEEPALIVE double ul_stat(int field) {
  auto m = mallinfo();
  if (field == 0) return m.arena;
  if (field == 1) return m.uordblks;
  if (field == 2) return m.fordblks;
  if (field == 3) return (uintptr_t)sbrk(0);
  if (!index_handle) return 0;
  auto s = reinterpret_cast<unum::usearch::index_dense_t*>(index_handle)->memory_stats();
  switch (field) {
    case 4: return s.graph_allocated;
    case 5: return s.graph_wasted;
    case 6: return s.graph_reserved;
    case 7: return s.vectors_allocated;
    case 8: return s.vectors_wasted;
    case 9: return s.vectors_reserved;
    default: return -1;
  }
}
EMSCRIPTEN_KEEPALIVE int ul_allocator_probe() {
  using allocator_t = unum::usearch::memory_mapping_allocator_gt<8, 1024u * 1024u>;
  allocator_t allocator;
  auto *first = allocator.allocate(1024u * 1024u - 16u);
  if (!first) return 1;
  first[0] = 42;
  auto *second = allocator.allocate(32);
  if (!second || first[0] != 42 || allocator.total_allocated() != 2u * 1024u * 1024u) return 2;
  if (allocator.allocate(1024u * 1024u) != nullptr) return 3;
  allocator_t moved(std::move(allocator));
  if (moved.total_allocated() != 2u * 1024u * 1024u || first[0] != 42) return 4;
  moved.reset();
  return moved.total_allocated() == 0 ? 0 : 5;
}
}
