# GNO Quickstart Demo - Full init → index → search flow
# Shows the complete getting started experience

Output "quickstart.gif"

Set Theme "TokyoNight"
Set FontFamily "JetBrains Mono"
Set FontSize 16
Set Width 900
Set Height 550
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
Type `mkdir -p $DEMO_DIR/notes`
Enter
Sleep 100ms
# Create realistic sample files
Type `cat > $DEMO_DIR/notes/project-notes.md << 'DOC'`
Enter
Type `# Project Notes`
Enter
Type ``
Enter
Type `## Meeting 2024-01-15`
Enter
Type `- Discussed authentication flow`
Enter
Type `- Decision: Use OAuth2 with refresh tokens`
Enter
Type `- Action items assigned to team`
Enter
Type ``
Enter
Type `## Architecture Decisions`
Enter
Type `We chose PostgreSQL for the database layer.`
Enter
Type `Redis for caching session data.`
Enter
Type `DOC`
Enter
Sleep 100ms
Type `cat > $DEMO_DIR/notes/api-docs.md << 'DOC'`
Enter
Type `# API Documentation`
Enter
Type ``
Enter
Type `## Endpoints`
Enter
Type `- POST /auth/login - User authentication`
Enter
Type `- GET /users/:id - Fetch user profile`
Enter
Type `- PUT /settings - Update preferences`
Enter
Type `DOC`
Enter
Sleep 100ms
Type `cd $DEMO_DIR`
Enter
Sleep 100ms
Type `clear`
Enter
Sleep 200ms
Show

# Visible demo
Sleep 500ms
Type "# Initialize GNO with your notes folder"
Enter
Sleep 600ms

Type "gno init notes --name project"
Sleep 400ms
Enter
Sleep 2s

Type ""
Enter
Sleep 300ms

Type "# Index your documents"
Enter
Sleep 600ms

Type "gno update"
Sleep 400ms
Enter
Sleep 2s

Type ""
Enter
Sleep 300ms

Type "# Search instantly"
Enter
Sleep 600ms

Type "gno search 'authentication'"
Sleep 400ms
Enter
Sleep 3s

Type ""
Enter
Sleep 300ms

Type "# Hybrid search for better results"
Enter
Sleep 600ms

Type "gno query 'database decision'"
Sleep 400ms
Enter
Sleep 3s
