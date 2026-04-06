package ratelimit

import (
	"net"
	"net/http"
	"sync"
	"time"
)

type tokenBucket struct {
	tokens     int
	refillAt   time.Time
	refillSize int
}

type Middleware struct {
	mu      sync.Mutex
	buckets map[string]*tokenBucket
	limit   int
	window  time.Duration
}

func New(limit int, window time.Duration) *Middleware {
	return &Middleware{
		buckets: map[string]*tokenBucket{},
		limit:   limit,
		window:  window,
	}
}

func (m *Middleware) Allow(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, _ := net.SplitHostPort(r.RemoteAddr)
		if !m.take(host) {
			http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (m *Middleware) take(clientIP string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()

	bucket, ok := m.buckets[clientIP]
	if !ok || time.Now().After(bucket.refillAt) {
		bucket = &tokenBucket{tokens: m.limit, refillAt: time.Now().Add(m.window), refillSize: m.limit}
		m.buckets[clientIP] = bucket
	}

	if bucket.tokens == 0 {
		return false
	}
	bucket.tokens--
	return true
}
