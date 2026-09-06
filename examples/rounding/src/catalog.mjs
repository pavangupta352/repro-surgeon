export const catalog = [
  { sku: 'paper', title: 'Recycled paper', price: 4.50, tags: ['office'] },
  { sku: 'pencil', title: 'Graphite pencil', price: 1.25, tags: ['office'] },
  { sku: 'notebook', title: 'Plain notebook', price: 6.00, tags: ['office', 'travel'] },
];

export function findProduct(sku) {
  return catalog.find(product => product.sku === sku);
}
