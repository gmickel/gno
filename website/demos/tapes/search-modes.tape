# GNO Search Modes Demo - BM25, Vector, and Hybrid search
# Shows the power of different search strategies

Output "search-modes.gif"

Set Theme "TokyoNight"
Set FontFamily "JetBrains Mono"
Set FontSize 16
Set Width 950
Set Height 600
Set Padding 20
Set TypingSpeed 35ms
Set CursorBlink false

# Hidden setup
Hide
Type `export DEMO_DIR=$(mktemp -d)`
Enter
Sleep 100ms
Type `export GNO_CONFIG_DIR=$DEMO_DIR/config GNO_DATA_DIR=$DEMO_DIR/data GNO_CACHE_DIR=$DEMO_DIR/cache`
Enter
Sleep 100ms
Type `mkdir -p $DEMO_DIR/docs`
Enter
Sleep 100ms
Type `cat > $DEMO_DIR/docs/auth.md << 'DOC'`
Enter
Type `# Authentication Guide`
Enter
Type ``
Enter
Type `Secure your API with token-based authentication.`
Enter
Type `Use JWT tokens for stateless auth.`
Enter
Type `Implement refresh token rotation for security.`
Enter
Type `DOC`
Enter
Sleep 100ms
Type `cat > $DEMO_DIR/docs/errors.md << 'DOC'`
Enter
Type `# Error Handling`
Enter
Type ``
Enter
Type `Handle errors gracefully in your application.`
Enter
Type `Use proper HTTP status codes.`
Enter
Type `Log errors for debugging purposes.`
Enter
Type `DOC`
Enter
Sleep 100ms
Type `cd $DEMO_DIR && gno init docs --name kb --yes > /dev/null 2>&1 && gno update --yes > /dev/null 2>&1`
Enter
Sleep 2s
Type `clear`
Enter
Sleep 200ms
Show

# Demo
Sleep 500ms
Type "# BM25: Fast keyword matching"
Enter
Sleep 600ms

Type "gno search 'JWT token'"
Sleep 400ms
Enter
Sleep 3s

Type ""
Enter
Sleep 400ms

Type "# Vector: Semantic similarity"
Enter
Sleep 600ms

Type "gno vsearch 'how to secure my API'"
Sleep 400ms
Enter
Sleep 3s

Type ""
Enter
Sleep 400ms

Type "# Hybrid: Best of both worlds"
Enter
Sleep 600ms

Type "gno query 'security best practices'"
Sleep 400ms
Enter
Sleep 3s
