#!/bin/bash
# Build VHS terminal demos for GNO documentation
# Usage: ./build-demos.sh [tape-name]
# If no tape name given, builds all tapes

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="$SCRIPT_DIR/../assets/demos"
TAPES_DIR="$SCRIPT_DIR/tapes"

mkdir -p "$OUTPUT_DIR"

# Check for VHS
if ! command -v vhs &> /dev/null; then
    echo "VHS not found. Install with: brew install charmbracelet/tap/vhs"
    exit 1
fi

# Check for gno
if ! command -v gno &> /dev/null; then
    echo "GNO not found. Install with: bun install -g gno"
    echo "Or run from repo: bun link"
    exit 1
fi

build_tape() {
    local tape="$1"
    local name=$(basename "$tape" .tape)

    echo "Building: $name.gif"
    vhs "$tape" -o "$OUTPUT_DIR/$name.gif"

    local size=$(ls -lh "$OUTPUT_DIR/$name.gif" | awk '{print $5}')
    echo "Created: $OUTPUT_DIR/$name.gif ($size)"
}

if [ -n "$1" ]; then
    # Build specific tape
    tape="$TAPES_DIR/$1.tape"
    if [ -f "$tape" ]; then
        build_tape "$tape"
    else
        echo "Tape not found: $1"
        echo ""
        echo "Available tapes:"
        for t in "$TAPES_DIR"/*.tape; do
            [ -f "$t" ] && echo "  $(basename "$t" .tape)"
        done
        exit 1
    fi
else
    # Build all tapes
    echo "Building all demo GIFs..."
    echo ""
    for tape in "$TAPES_DIR"/*.tape; do
        [ -f "$tape" ] && build_tape "$tape"
        echo ""
    done
fi

echo "Done! Demos in: $OUTPUT_DIR"
