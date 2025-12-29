# GNO Hero Demo - Quick impressive showcase for homepage
# Shows: fast search with beautiful results

Output "hero.gif"

# Visual settings - match GNO brand (Scholarly Dusk)
Set Theme "TokyoNight"
Set FontFamily "JetBrains Mono"
Set FontSize 18
Set Width 900
Set Height 500
Set Padding 24
Set TypingSpeed 40ms
Set CursorBlink false

# Hidden setup - create demo environment
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
# Create sample files
Type `cat > $DEMO_DIR/notes/api.md << 'DOC'`
Enter
Type `# API Reference`
Enter
Type ``
Enter
Type `## Authentication`
Enter
Type `GNO supports token-based authentication for API access.`
Enter
Type `Use Bearer tokens in the Authorization header.`
Enter
Type ``
Enter
Type `## Search Endpoint`
Enter
Type `POST /api/search - Query your indexed documents.`
Enter
Type `DOC`
Enter
Sleep 100ms
Type `cat > $DEMO_DIR/notes/guide.md << 'DOC'`
Enter
Type `# Quick Start Guide`
Enter
Type ``
Enter
Type `Get up and running with GNO in minutes.`
Enter
Type ``
Enter
Type `## Installation`
Enter
Type `Install via bun: bun install -g gno`
Enter
Type ``
Enter
Type `## Your First Search`
Enter
Type `Index your documents and search instantly.`
Enter
Type `DOC`
Enter
Sleep 100ms
# Initialize and index
Type `cd $DEMO_DIR && gno init notes --name docs --yes > /dev/null 2>&1`
Enter
Sleep 500ms
Type `gno update --yes > /dev/null 2>&1`
Enter
Sleep 1s
Type `clear`
Enter
Sleep 300ms
Show

# The visible demo starts here
Sleep 500ms
Type "# Search your documents instantly"
Sleep 300ms
Enter
Sleep 800ms

Type "gno search 'authentication API'"
Sleep 600ms
Enter
Sleep 3s

Type@100ms ""
Enter
Sleep 500ms

Type "# Get AI-powered answers"
Sleep 300ms
Enter
Sleep 800ms

Type "gno ask 'how do I authenticate?' --limit 1"
Sleep 600ms
Enter
Sleep 3s
