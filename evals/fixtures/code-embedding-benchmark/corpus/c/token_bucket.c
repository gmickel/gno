#include <stdbool.h>
#include <stddef.h>
#include <time.h>

typedef struct {
  size_t tokens;
  size_t capacity;
  double refill_rate;
  double last_refill;
} token_bucket;

static double now_seconds(void) {
  return (double)clock() / (double)CLOCKS_PER_SEC;
}

void bucket_refill(token_bucket *bucket) {
  double current = now_seconds();
  double elapsed = current - bucket->last_refill;
  size_t refill = (size_t)(elapsed * bucket->refill_rate);
  if (refill == 0) {
    return;
  }

  bucket->tokens += refill;
  if (bucket->tokens > bucket->capacity) {
    bucket->tokens = bucket->capacity;
  }
  bucket->last_refill = current;
}

bool bucket_take(token_bucket *bucket) {
  bucket_refill(bucket);
  if (bucket->tokens == 0) {
    return false;
  }
  bucket->tokens -= 1;
  return true;
}
