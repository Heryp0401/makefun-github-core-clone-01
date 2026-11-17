// Package graphql implements a small hand-written GraphQL lexer, parser and
// executor for the fixed document set the conformance suite sends. It uses
// only the standard library: no GraphQL framework, no schema engine. The
// parser is a recursive-descent parser over the token stream produced here.
package graphql

import (
	"fmt"
	"strings"
)

// TokenKind identifies one lexical unit of a GraphQL document.
type TokenKind int

const (
	TokEOF TokenKind = iota
	TokIdent
	TokString
	TokInt
	TokFloat
	TokDollar
	TokBang
	TokColon
	TokEquals
	TokLParen
	TokRParen
	TokLBrace
	TokRBrace
	TokLBracket
	TokRBracket
	TokEllipsis
	TokAt
	TokPipe
	TokAmp
)

// Token is a single lexed unit. Lit holds the decoded text: for a string
// token the unescaped contents, for a name or number the raw spelling.
type Token struct {
	Kind TokenKind
	Lit  string
	Pos  int
}

// Lexer scans a GraphQL document into tokens. Commas are insignificant in
// GraphQL and are skipped, as are whitespace and #-comments.
type Lexer struct {
	src string
	pos int
}

// NewLexer returns a lexer over src.
func NewLexer(src string) *Lexer { return &Lexer{src: src} }

func isNameStart(c byte) bool {
	return c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

func isNameChar(c byte) bool {
	return isNameStart(c) || (c >= '0' && c <= '9')
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

// Next returns the next token. At end of input it returns TokEOF forever.
func (l *Lexer) Next() Token {
	for l.pos < len(l.src) {
		c := l.src[l.pos]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == ',':
			l.pos++
		case c == '#':
			for l.pos < len(l.src) && l.src[l.pos] != '\n' {
				l.pos++
			}
		default:
			return l.nextToken()
		}
	}
	return Token{Kind: TokEOF, Pos: l.pos}
}

func (l *Lexer) nextToken() Token {
	start := l.pos
	c := l.src[l.pos]
	switch c {
	case '$':
		l.pos++
		return Token{Kind: TokDollar, Lit: "$", Pos: start}
	case '!':
		l.pos++
		return Token{Kind: TokBang, Lit: "!", Pos: start}
	case ':':
		l.pos++
		return Token{Kind: TokColon, Lit: ":", Pos: start}
	case '=':
		l.pos++
		return Token{Kind: TokEquals, Lit: "=", Pos: start}
	case '(':
		l.pos++
		return Token{Kind: TokLParen, Lit: "(", Pos: start}
	case ')':
		l.pos++
		return Token{Kind: TokRParen, Lit: ")", Pos: start}
	case '{':
		l.pos++
		return Token{Kind: TokLBrace, Lit: "{", Pos: start}
	case '}':
		l.pos++
		return Token{Kind: TokRBrace, Lit: "}", Pos: start}
	case '[':
		l.pos++
		return Token{Kind: TokLBracket, Lit: "[", Pos: start}
	case ']':
		l.pos++
		return Token{Kind: TokRBracket, Lit: "]", Pos: start}
	case '@':
		l.pos++
		return Token{Kind: TokAt, Lit: "@", Pos: start}
	case '|':
		l.pos++
		return Token{Kind: TokPipe, Lit: "|", Pos: start}
	case '&':
		l.pos++
		return Token{Kind: TokAmp, Lit: "&", Pos: start}
	case '.':
		if l.pos+2 < len(l.src) && l.src[l.pos+1] == '.' && l.src[l.pos+2] == '.' {
			l.pos += 3
			return Token{Kind: TokEllipsis, Lit: "...", Pos: start}
		}
		l.pos++
		return Token{Kind: TokEOF, Lit: "", Pos: start}
	case '"':
		return l.lexString()
	case '-', '+':
		if l.pos+1 < len(l.src) && isDigit(l.src[l.pos+1]) {
			return l.lexNumber()
		}
		l.pos++
		return Token{Kind: TokEOF, Lit: "", Pos: start}
	}
	if isDigit(c) {
		return l.lexNumber()
	}
	if isNameStart(c) {
		for l.pos < len(l.src) && isNameChar(l.src[l.pos]) {
			l.pos++
		}
		return Token{Kind: TokIdent, Lit: l.src[start:l.pos], Pos: start}
	}
	l.pos++
	return Token{Kind: TokEOF, Lit: "", Pos: start}
}

func (l *Lexer) lexNumber() Token {
	start := l.pos
	if l.src[l.pos] == '-' || l.src[l.pos] == '+' {
		l.pos++
	}
	for l.pos < len(l.src) && isDigit(l.src[l.pos]) {
		l.pos++
	}
	isFloat := false
	if l.pos < len(l.src) && l.src[l.pos] == '.' {
		isFloat = true
		l.pos++
		for l.pos < len(l.src) && isDigit(l.src[l.pos]) {
			l.pos++
		}
	}
	if l.pos < len(l.src) && (l.src[l.pos] == 'e' || l.src[l.pos] == 'E') {
		isFloat = true
		l.pos++
		if l.pos < len(l.src) && (l.src[l.pos] == '-' || l.src[l.pos] == '+') {
			l.pos++
		}
		for l.pos < len(l.src) && isDigit(l.src[l.pos]) {
			l.pos++
		}
	}
	kind := TokInt
	if isFloat {
		kind = TokFloat
	}
	return Token{Kind: kind, Lit: l.src[start:l.pos], Pos: start}
}

// lexString lexes a double-quoted string, decoding the usual escapes.
// A triple-quoted block string is also accepted and returned raw.
func (l *Lexer) lexString() Token {
	start := l.pos
	if strings.HasPrefix(l.src[l.pos:], `"""`) {
		end := strings.Index(l.src[l.pos+3:], `"""`)
		if end < 0 {
			l.pos = len(l.src)
			return Token{Kind: TokString, Lit: "", Pos: start}
		}
		lit := l.src[l.pos+3 : l.pos+3+end]
		l.pos += 3 + end + 3
		return Token{Kind: TokString, Lit: lit, Pos: start}
	}
	l.pos++ // opening quote
	var b strings.Builder
	for l.pos < len(l.src) {
		c := l.src[l.pos]
		if c == '"' {
			l.pos++
			return Token{Kind: TokString, Lit: b.String(), Pos: start}
		}
		if c == '\\' && l.pos+1 < len(l.src) {
			n := l.src[l.pos+1]
			l.pos += 2
			switch n {
			case '"':
				b.WriteByte('"')
			case '\\':
				b.WriteByte('\\')
			case '/':
				b.WriteByte('/')
			case 'b':
				b.WriteByte('\b')
			case 'f':
				b.WriteByte('\f')
			case 'n':
				b.WriteByte('\n')
			case 'r':
				b.WriteByte('\r')
			case 't':
				b.WriteByte('\t')
			case 'u':
				if l.pos+4 <= len(l.src) {
					var r rune
					_, err := fmt.Sscanf(l.src[l.pos:l.pos+4], "%04x", &r)
					if err == nil {
						b.WriteRune(r)
					}
					l.pos += 4
				}
			default:
				b.WriteByte(n)
			}
			continue
		}
		b.WriteByte(c)
		l.pos++
	}
	return Token{Kind: TokString, Lit: b.String(), Pos: start}
}
