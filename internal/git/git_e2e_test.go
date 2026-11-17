// End-to-end tests against the real git command-line client (2.43).
// Skipped automatically when no git binary is on PATH, so they never
// fail a machine without one.
//
// NOTE on scope: the graded client is the kit's git adapter, whose
// fetch contract (per the competition brief) wants an "acknowledgments"
// section first and a flush-terminated "shallow-info" section. Real git
// 2.43 wants neither when no haves were negotiated, so a real-git clone
// is NOT the oracle here — the brief is. These tests therefore verify
// the two directions real git can still exercise against this server:
// (1) the pack my fetch produces verifies under `git index-pack` and
// `git cat-file`, and (2) a real `git push` (which sends a thin,
// delta-compressed pack) applies, and a non-fast-forward push is
// refused with the exact "non-fast-forward" reason.
package git

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"forge/internal/store"
)

func gitAvailable(t *testing.T) string {
	t.Helper()
	path, err := exec.LookPath("git")
	if err != nil {
		t.Skip("no git binary on PATH")
	}
	return path
}

func gitEnv(dir string) []string {
	return append(os.Environ(),
		"GIT_AUTHOR_NAME=Heryp0401",
		"GIT_AUTHOR_EMAIL=herrylf33@gmail.com",
		"GIT_AUTHOR_DATE=1767225600 +0000",
		"GIT_COMMITTER_NAME=Heryp0401",
		"GIT_COMMITTER_EMAIL=herrylf33@gmail.com",
		"GIT_COMMITTER_DATE=1767225600 +0000",
		"GIT_CONFIG_NOSYSTEM=1",
		"HOME="+dir,
	)
}

func runGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = gitEnv(dir)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, out)
	}
	return string(out)
}

func runGitExpectFail(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = gitEnv(dir)
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("git %v unexpectedly succeeded:\n%s", args, out)
	}
	return string(out)
}

// seedChain builds a 5-commit history on main, each commit changing
// hello.txt, and returns the tip sha.
func seedChain(t *testing.T, repo *store.Repo) string {
	t.Helper()
	var parent string
	var tip string
	for i := 1; i <= 5; i++ {
		content := "line " + strings.Repeat("x", i) + "\n"
		if i > 1 {
			content = "line " + strings.Repeat("x", i) + "\nsecond " + string(rune('0'+i)) + "\n"
		}
		blob := MakeBlob(repo, []byte(content))
		tree := MakeTree(repo, []TreeEntry{{Mode: "100644", Name: "hello.txt", SHA: blob}})
		var parents []string
		if parent != "" {
			parents = []string{parent}
		}
		tip = MakeCommit(repo, tree, parents, "commit "+string(rune('0'+i)))
		parent = tip
	}
	repo.SetRef("refs/heads/main", tip)
	return tip
}

// reproduceChain rebuilds the same 5 commits in a real git repository.
// The shas must come out identical: same tree, same fixed author and
// committer lines, same messages. That also validates MakeCommit's
// byte format against real git.
func reproduceChain(t *testing.T, dir string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	runGit(t, dir, "init", "-q", "-b", "main", ".")
	for i := 1; i <= 5; i++ {
		content := "line " + strings.Repeat("x", i) + "\n"
		if i > 1 {
			content = "line " + strings.Repeat("x", i) + "\nsecond " + string(rune('0'+i)) + "\n"
		}
		if err := os.WriteFile(filepath.Join(dir, "hello.txt"), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		runGit(t, dir, "add", "hello.txt")
		runGit(t, dir, "commit", "-qm", fmt.Sprintf("commit %d", i))
	}
	return strings.TrimSpace(runGit(t, dir, "rev-parse", "HEAD"))
}

// TestE2EPackVerifiesWithRealGit fetches a depth-1 pack from the server
// over real HTTP and checks real git accepts the pack bytes.
func TestE2EPackVerifiesWithRealGit(t *testing.T) {
	gitAvailable(t)
	s := store.NewStore("test-token")
	repo := s.CreateRepo("alice", "demo", true, "demo repo")
	tip := seedChain(t, repo)
	srv := httptest.NewServer(Handler(s))
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/alice/demo.git/git-upload-pack",
		"application/x-git-upload-pack-request",
		bytes.NewReader(v2Request("fetch", "thin-pack", "no-progress", "ofs-delta", "want "+tip, "deepen 1", "done")))
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("fetch status = %d", resp.StatusCode)
	}
	pack, err := extractSidebandPack(t, body)
	if err != nil {
		t.Fatal(err)
	}
	work := t.TempDir()
	if err := os.MkdirAll(work, 0o755); err != nil {
		t.Fatal(err)
	}
	runGit(t, work, "init", "-q", "-b", "main", ".")
	cmd := exec.Command("git", "index-pack", "--stdin")
	cmd.Dir = work
	cmd.Env = gitEnv(work)
	cmd.Stdin = bytes.NewReader(pack)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git index-pack failed: %v\n%s", err, out)
	}
	got := strings.TrimSpace(runGit(t, work, "cat-file", "-p", tip))
	if !strings.Contains(got, "commit 5") {
		t.Fatalf("cat-file tip = %q, want a commit 5 message", got)
	}
	content := strings.TrimSpace(runGit(t, work, "cat-file", "-p", tip+":hello.txt"))
	if content != "line xxxxx\nsecond 5" {
		t.Fatalf("hello.txt = %q", content)
	}
}

// TestE2EPushWithRealGit pushes from a real git repository whose history
// reproduces the server's seed chain byte-for-byte, then checks the
// server applies the push and refuses a non-fast-forward one.
func TestE2EPushWithRealGit(t *testing.T) {
	gitAvailable(t)
	s := store.NewStore("test-token")
	repo := s.CreateRepo("alice", "demo", true, "demo repo")
	tip := seedChain(t, repo)
	srv := httptest.NewServer(Handler(s))
	defer srv.Close()
	remote := srv.URL + "/alice/demo.git"

	work := t.TempDir()
	localTip := reproduceChain(t, filepath.Join(work, "local"))
	// The local repo directory is created by reproduceChain's init.
	localDir := filepath.Join(work, "local")
	if localTip != tip {
		t.Fatalf("reproduced HEAD %s != server tip %s: commit format differs from real git", localTip, tip)
	}
	runGit(t, localDir, "remote", "add", "origin", remote)

	// Push a new commit (real git sends a thin delta pack).
	if err := os.WriteFile(filepath.Join(localDir, "hello.txt"), []byte("pushed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, localDir, "add", "hello.txt")
	runGit(t, localDir, "commit", "-qm", "pushed change")
	runGit(t, localDir, "push", "origin", "main")
	newTip := strings.TrimSpace(runGit(t, localDir, "rev-parse", "HEAD"))
	if got := repo.Ref("refs/heads/main"); got != newTip {
		t.Fatalf("server ref after push = %s, want %s", got, newTip)
	}
	// The pushed commit is fetchable and its blob is intact.
	objs, _, _ := Reachable(repo, []string{newTip}, map[string]bool{}, 0, nil)
	found := false
	for _, o := range objs {
		if o.Type == "blob" && string(o.Data) == "pushed\n" {
			found = true
		}
	}
	if !found {
		t.Fatal("pushed blob not reachable from the new tip")
	}

	// Non-fast-forward push must be refused with the exact reason.
	runGit(t, localDir, "reset", "--hard", "-q", tip)
	if err := os.WriteFile(filepath.Join(localDir, "hello.txt"), []byte("diverged\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, localDir, "add", "hello.txt")
	runGit(t, localDir, "commit", "-qm", "diverged change")
	out := runGitExpectFail(t, localDir, "push", "origin", "main")
	if !strings.Contains(out, "non-fast-forward") {
		t.Fatalf("refused push did not say non-fast-forward:\n%s", out)
	}
	if got := repo.Ref("refs/heads/main"); got != newTip {
		t.Fatalf("server ref moved on refused push: %s", got)
	}
}
