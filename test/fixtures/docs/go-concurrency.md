# Go Concurrency Patterns

Goroutines and channels for safe concurrent programming.

## Goroutines

Lightweight threads managed by Go runtime:

```go
package main

import (
    "fmt"
    "time"
)

func worker(id int, jobs <-chan int, results chan<- int) {
    for job := range jobs {
        fmt.Printf("Worker %d processing job %d\n", id, job)
        time.Sleep(time.Second)
        results <- job * 2
    }
}

func main() {
    jobs := make(chan int, 100)
    results := make(chan int, 100)

    // Start 3 workers
    for w := 1; w <= 3; w++ {
        go worker(w, jobs, results)
    }

    // Send 5 jobs
    for j := 1; j <= 5; j++ {
        jobs <- j
    }
    close(jobs)

    // Collect results
    for a := 1; a <= 5; a++ {
        <-results
    }
}
```

## Select Statement

Handle multiple channels:

```go
func multiplexer(ch1, ch2 <-chan string, quit <-chan bool) {
    for {
        select {
        case msg := <-ch1:
            fmt.Println("Channel 1:", msg)
        case msg := <-ch2:
            fmt.Println("Channel 2:", msg)
        case <-quit:
            fmt.Println("Shutting down")
            return
        case <-time.After(5 * time.Second):
            fmt.Println("Timeout - no messages")
        }
    }
}
```

## WaitGroups

Wait for goroutines to complete:

```go
func fetchAll(urls []string) []Response {
    var wg sync.WaitGroup
    results := make([]Response, len(urls))

    for i, url := range urls {
        wg.Add(1)
        go func(idx int, u string) {
            defer wg.Done()
            results[idx] = fetch(u)
        }(i, url)
    }

    wg.Wait()
    return results
}
```

## Mutex for Shared State

Protect concurrent access:

```go
type Counter struct {
    mu    sync.Mutex
    value int
}

func (c *Counter) Increment() {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.value++
}

func (c *Counter) Value() int {
    c.mu.Lock()
    defer c.mu.Unlock()
    return c.value
}
```

## Context for Cancellation

Propagate cancellation signals:

```go
func processWithTimeout(ctx context.Context, data []Item) error {
    ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
    defer cancel()

    for _, item := range data {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
            if err := process(item); err != nil {
                return err
            }
        }
    }
    return nil
}
```

## Error Groups

Handle errors from concurrent operations:

```go
import "golang.org/x/sync/errgroup"

func fetchAllWithErrors(urls []string) ([]Response, error) {
    g, ctx := errgroup.WithContext(context.Background())
    results := make([]Response, len(urls))

    for i, url := range urls {
        i, url := i, url // Capture loop variables
        g.Go(func() error {
            resp, err := fetchWithContext(ctx, url)
            if err != nil {
                return err
            }
            results[i] = resp
            return nil
        })
    }

    if err := g.Wait(); err != nil {
        return nil, err
    }
    return results, nil
}
```
