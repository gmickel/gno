export function debounce<TArgs extends unknown[]>(
  fn: (...args: TArgs) => void,
  delayMs: number
) {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return (...args: TArgs) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      timeoutId = null;
      fn(...args);
    }, delayMs);
  };
}

export function wireSearchInput(
  input: HTMLInputElement,
  onSearch: (value: string) => void
) {
  const handler = debounce((value: string) => onSearch(value), 250);
  input.addEventListener("input", () => {
    handler(input.value.trim());
  });
}
