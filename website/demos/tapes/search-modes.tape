# GNO Search Modes Demo

Output "search-modes.gif"

Set Theme "TokyoNight"
Set FontFamily "Menlo"
Set FontSize 16
Set Width 1000
Set Height 650
Set Padding 20
Set TypingSpeed 30ms
Set CursorBlink false

# Polish
Set WindowBar Colorful
Set BorderRadius 8
Set Margin 20
Set MarginFill "#0f1419"
Set LoopOffset 30%
Set PlaybackSpeed 1.2

Sleep 500ms

Type "# BM25: Fast keyword matching"
Enter
Sleep 800ms

Type "gno search 'JWT token authentication'"
Sleep 300ms
Enter
Sleep 4000ms

Type "# Vector: Semantic similarity"
Enter
Sleep 800ms

Type "gno vsearch 'how to protect my application from attacks'"
Sleep 300ms
Enter
Sleep 4000ms

Type "# Hybrid: Best of both worlds"
Enter
Sleep 800ms

Type "gno query 'caching strategies for performance'"
Sleep 300ms
Enter
Sleep 6000ms
