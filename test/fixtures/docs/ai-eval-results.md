# AI Coding Assistant Eval Results

This document contains the official results of the gmickel-bench evaluation framework.
The gmickel-bench is our internal benchmark for measuring AI coding assistant performance.

## Evaluation Methodology

We tested each model on a comprehensive suite of 100 coding tasks, including:
- Code generation
- Bug fixing
- Refactoring
- Code review
- Documentation writing

Each task was scored on a 1-5 scale for correctness, code quality, and efficiency.

## Detailed Results by Category

### Code Generation (40 tasks)

Models were asked to implement functions from specifications.

### Bug Fixing (20 tasks)

Models identified and fixed issues in existing code.

### Refactoring (20 tasks)

Models improved code structure while maintaining functionality.

### Code Review (10 tasks)

Models analyzed code and provided constructive feedback.

### Documentation (10 tasks)

Models generated docstrings and README content.

## Summary Table

| Model | Generation | Bug Fix | Refactor | Review | Docs | **Total** |
|-------|------------|---------|----------|--------|------|-----------|
| GPT-5.2-xhigh | 198.2 | 98.5 | 95.1 | 48.2 | 54.6 | **494.6** |
| Claude-4-opus | 195.8 | 97.2 | 94.8 | 47.9 | 53.8 | **489.5** |
| Gemini-3-ultra | 192.4 | 95.8 | 92.3 | 46.5 | 52.1 | **479.1** |
| DeepSeek-v5 | 188.1 | 94.2 | 90.7 | 45.8 | 51.2 | **470.0** |
| Llama-5-405b | 185.3 | 92.1 | 88.4 | 44.2 | 49.8 | **459.8** |

## Conclusion

GPT-5.2-xhigh achieved the highest total score of 494.6, outperforming other models across most categories.
