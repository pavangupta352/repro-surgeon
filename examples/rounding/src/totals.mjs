export function totalCents(items) {
  return items.reduce((total, item) => total + Math.round(item.price * 100), 0);
}

export function formatCents(cents, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

export function withTax(cents, rate) {
  return Math.round(cents * (1 + rate));
}
