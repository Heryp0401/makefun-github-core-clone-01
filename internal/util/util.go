// Package util provides small shared helpers: fixed time, JSON replies,
// and request IDs.
package util

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync/atomic"
)

// FixedTime is the deterministic timestamp every served record uses.
// Trials are seeded: no wall clock, no randomness in served data.
const FixedTime = "2026-01-01T00:00:00Z"

// FixedUnix is FixedTime as a Unix epoch (for git author/committer lines).
const FixedUnix = 1767225600

var reqCounter int64

// Now returns the fixed trial timestamp.
func Now() string { return FixedTime }

// NowUnix returns the fixed trial timestamp as Unix seconds.
func NowUnix() int64 { return FixedUnix }

// NewRequestID returns a cheap unique request id ("req-<n>").
// The wire contract requires only a non-empty X-GitHub-Request-Id.
func NewRequestID() string {
	n := atomic.AddInt64(&reqCounter, 1)
	return fmt.Sprintf("req-%d", n)
}

// WriteJSON marshals v and writes it as an application/json reply.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		WriteErr(w, http.StatusInternalServerError, "encode error")
		return
	}
	WriteJSONBytes(w, status, b)
}

// WriteJSONBytes writes pre-serialized JSON bytes as an application/json reply.
func WriteJSONBytes(w http.ResponseWriter, status int, b []byte) {
	h := w.Header()
	h.Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(b)
}

// WriteErr writes a JSON error body {"message": msg}.
func WriteErr(w http.ResponseWriter, status int, msg string) {
	WriteJSON(w, status, map[string]string{"message": msg})
}
