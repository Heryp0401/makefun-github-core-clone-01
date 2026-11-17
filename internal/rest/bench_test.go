package rest

import (
	"encoding/json"
	"net/http"
	"strconv"
	"testing"
)

// BenchmarkGetSingleIssue mirrors the read workload: 2000 sequential GETs
// of one issue on one handler (in-process; no network).
func BenchmarkGetSingleIssue(b *testing.B) {
	s := newTestStore()
	h := Handler(s)
	setupIssueRepo(b, h, "bench")
	n := createIssue(b, h, "bench", "bench issue", nil)
	path := "/api/v3/repos/alice/bench/issues/" + strconv.Itoa(n)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		w := doReq(b, h, "GET", path, "")
		if w.Code != http.StatusOK {
			b.Fatalf("status = %d", w.Code)
		}
	}
}

// BenchmarkCreateIssue mirrors the write workload: 200 sequential POSTs.
func BenchmarkCreateIssue(b *testing.B) {
	s := newTestStore()
	h := Handler(s)
	setupIssueRepo(b, h, "benchw")
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		body, _ := json.Marshal(map[string]string{
			"title": "issue " + strconv.Itoa(i),
			"body":  "body",
		})
		w := doReq(b, h, "POST", "/api/v3/repos/alice/benchw/issues", string(body))
		if w.Code != http.StatusCreated {
			b.Fatalf("status = %d", w.Code)
		}
	}
}
