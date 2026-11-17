// Package git implements the git smart-HTTP layer of the forge: pkt-line
// framing, loose objects, packfiles (parse and generate, including delta
// resolution), upload-pack protocol v2 and receive-pack v0.
//
// Everything here is derived from the git wire protocol as described in the
// competition contract: pkt-lines are a 4-hex-digit length (including the
// 4 header bytes), "0000" is a flush packet and "0001" a delimiter packet.
package git

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"strconv"
)

// maxPktLine is the largest legal pkt-line payload: 65520 bytes total
// including the 4-byte length header.
const maxPktLine = 65520

// pktKind classifies one parsed pkt-line.
type pktKind int

const (
	pktData pktKind = iota
	pktFlush
	pktDelim
)

// pktLine is one parsed pkt-line: either data, a flush, or a delimiter.
type pktLine struct {
	kind pktKind
	data []byte // only for pktData; content without the length header
}

// writePktLine appends one pkt-line carrying s to buf. s must fit in a
// single pkt-line; longer payloads are the caller's job to chunk.
func writePktLine(buf *bytes.Buffer, s string) error {
	if len(s)+4 > maxPktLine {
		return fmt.Errorf("pkt-line too long: %d bytes", len(s))
	}
	var hdr [4]byte
	putHexLen(hdr[:], len(s)+4)
	buf.Write(hdr[:])
	buf.WriteString(s)
	return nil
}

// writePktBytes appends one pkt-line carrying raw bytes b to buf.
func writePktBytes(buf *bytes.Buffer, b []byte) error {
	if len(b)+4 > maxPktLine {
		return fmt.Errorf("pkt-line too long: %d bytes", len(b))
	}
	var hdr [4]byte
	putHexLen(hdr[:], len(b)+4)
	buf.Write(hdr[:])
	buf.Write(b)
	return nil
}

// putHexLen writes n as 4 lowercase hex digits into dst (len 4).
func putHexLen(dst []byte, n int) {
	const digits = "0123456789abcdef"
	dst[0] = digits[(n>>12)&0xf]
	dst[1] = digits[(n>>8)&0xf]
	dst[2] = digits[(n>>4)&0xf]
	dst[3] = digits[n&0xf]
}

// writeFlush appends a flush packet ("0000").
func writeFlush(buf *bytes.Buffer) {
	buf.WriteString("0000")
}

// writeDelim appends a delimiter packet ("0001").
func writeDelim(buf *bytes.Buffer) {
	buf.WriteString("0001")
}

// parsePktLines splits a whole request body into pkt-lines. A trailing
// partial line is an error. The returned data slices alias the input.
func parsePktLines(data []byte) ([]pktLine, error) {
	var out []pktLine
	pos := 0
	for pos < len(data) {
		if len(data)-pos < 4 {
			return nil, errors.New("truncated pkt-line header")
		}
		n64, err := strconv.ParseUint(string(data[pos:pos+4]), 16, 32)
		if err != nil {
			return nil, fmt.Errorf("bad pkt-line length %q: %w", data[pos:pos+4], err)
		}
		n := int(n64)
		if n == 0 {
			out = append(out, pktLine{kind: pktFlush})
			pos += 4
			continue
		}
		if n == 1 {
			out = append(out, pktLine{kind: pktDelim})
			pos += 4
			continue
		}
		if n < 4 || pos+n > len(data) {
			return nil, fmt.Errorf("pkt-line length %d out of range at %d", n, pos)
		}
		out = append(out, pktLine{kind: pktData, data: data[pos+4 : pos+n]})
		pos += n
	}
	return out, nil
}

// pktLineStrings returns the data payloads of parsed lines as strings,
// skipping flush and delimiter packets.
func pktLineStrings(lines []pktLine) []string {
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		if l.kind == pktData {
			out = append(out, string(l.data))
		}
	}
	return out
}

// sidebandFrame wraps payload bytes as sideband band-1 pkt-lines appended
// to buf: each chunk is at most 65515 payload bytes so the whole pkt-line
// (4 header + 1 band + payload) stays within 65520. A flush packet ends
// the stream.
func sidebandFrame(buf *bytes.Buffer, payload []byte) {
	const maxPayload = maxPktLine - 5 // 4 header + 1 band byte
	for len(payload) > 0 {
		n := len(payload)
		if n > maxPayload {
			n = maxPayload
		}
		var hdr [4]byte
		putHexLen(hdr[:], n+5)
		buf.Write(hdr[:])
		buf.WriteByte(1) // band 1: pack data / report text
		buf.Write(payload[:n])
		payload = payload[n:]
	}
	writeFlush(buf)
}

// countingByteReader counts every byte pulled from the underlying slice.
// It implements io.ByteReader so compress/flate reads it one byte at a
// time and never buffers ahead past the stream it is decoding.
type countingByteReader struct {
	data []byte
	pos  int
	read int // bytes handed out so far
}

func (c *countingByteReader) Read(p []byte) (int, error) {
	if c.pos >= len(c.data) {
		return 0, io.EOF
	}
	n := copy(p, c.data[c.pos:])
	c.pos += n
	c.read += n
	return n, nil
}

func (c *countingByteReader) ReadByte() (byte, error) {
	if c.pos >= len(c.data) {
		return 0, io.EOF
	}
	b := c.data[c.pos]
	c.pos++
	c.read++
	return b, nil
}

// trailerChecksum returns the Adler-32 checksum (big-endian) stored in the
// last four bytes of data, and whether data is long enough to hold one.
func trailerChecksum(data []byte) (uint32, bool) {
	if len(data) < 4 {
		return 0, false
	}
	return binary.BigEndian.Uint32(data[len(data)-4:]), true
}
