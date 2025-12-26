# Asynchronous Python

Modern async/await patterns for concurrent Python applications.

## Basic Coroutines

Define async functions with async/await:

```python
import asyncio

async def fetch_data(url: str) -> dict:
    async with aiohttp.ClientSession() as session:
        async with session.get(url) as response:
            return await response.json()

async def main():
    data = await fetch_data("https://api.example.com/data")
    print(data)

asyncio.run(main())
```

## Concurrent Execution

Run multiple coroutines in parallel:

```python
async def fetch_all_users(user_ids: list[str]) -> list[User]:
    tasks = [fetch_user(uid) for uid in user_ids]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    users = []
    for result in results:
        if isinstance(result, Exception):
            logger.error(f"Failed to fetch user: {result}")
        else:
            users.append(result)

    return users
```

## Async Context Managers

Manage async resources properly:

```python
class AsyncDatabasePool:
    async def __aenter__(self):
        self.pool = await asyncpg.create_pool(
            host='localhost',
            database='myapp',
            min_size=5,
            max_size=20
        )
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        await self.pool.close()

    async def execute(self, query: str, *args):
        async with self.pool.acquire() as conn:
            return await conn.fetch(query, *args)
```

## Async Generators

Stream data asynchronously:

```python
async def read_large_file(path: str) -> AsyncIterator[str]:
    async with aiofiles.open(path, 'r') as f:
        async for line in f:
            yield line.strip()

async def process_logs():
    async for line in read_large_file('/var/log/app.log'):
        if 'ERROR' in line:
            await alert_team(line)
```

## Semaphores for Rate Limiting

Control concurrent access:

```python
semaphore = asyncio.Semaphore(10)  # Max 10 concurrent requests

async def rate_limited_fetch(url: str) -> dict:
    async with semaphore:
        return await fetch_data(url)

async def batch_fetch(urls: list[str]) -> list[dict]:
    tasks = [rate_limited_fetch(url) for url in urls]
    return await asyncio.gather(*tasks)
```

## Timeouts

Prevent hanging operations:

```python
async def fetch_with_timeout(url: str, timeout: float = 5.0) -> dict:
    try:
        return await asyncio.wait_for(fetch_data(url), timeout=timeout)
    except asyncio.TimeoutError:
        raise FetchError(f"Request to {url} timed out after {timeout}s")
```
