# GNO Documentation Corpus

Test corpus for validating documentation examples.

## Purpose

This directory contains sample documents used by `bun run docs:verify` to validate that quickstart commands work as documented.

## Contents

- `quickstart.md` - Sample notes for testing basic search
- `api-reference.md` - Sample API docs for testing code search
- `troubleshooting.md` - Sample troubleshooting content

## Usage

These files are indexed and searched during docs verification. They contain known terms that documentation examples reference:

- "authentication" - found in api-reference.md
- "error" - found in troubleshooting.md
- "quickstart" - found in quickstart.md

Keep content stable - changing terms may break docs verification.
