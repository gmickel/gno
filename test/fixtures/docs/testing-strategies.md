# Testing Strategies

Comprehensive testing ensures code quality and prevents regressions.

## Unit Testing

Test individual functions in isolation:

```typescript
import { describe, expect, test } from "bun:test";
import { calculateDiscount } from "./pricing";

describe("calculateDiscount", () => {
  test("applies percentage discount correctly", () => {
    expect(calculateDiscount(100, 0.1)).toBe(90);
  });

  test("returns original price for zero discount", () => {
    expect(calculateDiscount(100, 0)).toBe(100);
  });

  test("throws for negative discount", () => {
    expect(() => calculateDiscount(100, -0.1)).toThrow("Invalid discount");
  });
});
```

## Integration Testing

Test component interactions:

```typescript
import { afterEach, beforeEach, describe, test } from "bun:test";
import { createTestDatabase, seedTestData } from "./helpers";

describe("UserService", () => {
  let db: Database;
  let userService: UserService;

  beforeEach(async () => {
    db = await createTestDatabase();
    await seedTestData(db);
    userService = new UserService(db);
  });

  afterEach(async () => {
    await db.close();
  });

  test("creates user and sends welcome email", async () => {
    const user = await userService.register({
      email: "new@example.com",
      password: "secret123",
    });

    expect(user.id).toBeDefined();
    expect(emailService.sent).toContainEqual({
      to: "new@example.com",
      template: "welcome",
    });
  });
});
```

## End-to-End Testing

Test complete user flows:

```typescript
import { expect, test } from "@playwright/test";

test("user can complete checkout flow", async ({ page }) => {
  await page.goto("/products");
  await page.click('[data-testid="product-1"]');
  await page.click('button:has-text("Add to Cart")');
  await page.click('[data-testid="checkout-button"]');

  await page.fill('[name="email"]', "test@example.com");
  await page.fill('[name="card"]', "4242424242424242");
  await page.click('button:has-text("Pay Now")');

  await expect(page.locator(".success-message")).toBeVisible();
});
```

## Test Coverage

Aim for meaningful coverage, not 100%:

- Focus on business logic
- Skip trivial getters/setters
- Test edge cases and error paths
- Don't mock what you don't own

## Mocking Best Practices

Mock external dependencies only:

```typescript
import { mock } from "bun:test";

const mockFetch = mock(() =>
  Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ data: "mocked" }),
  })
);

// Inject mock into service
const service = new ApiService(mockFetch);
```
