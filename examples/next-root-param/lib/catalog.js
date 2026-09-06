export const entries = [{ title: 'Notebook', amount: 12 }, { title: 'Pencil', amount: 2 }];
export function sum() { return entries.reduce((value, entry) => value + entry.amount, 0); }
