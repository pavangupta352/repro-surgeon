export default function Home() {
  return null;
}

export async function getStaticProps() {
  const unusedSummary = { label: 'Owned build fixture', expected: 12 };
  throw new Error('OWNED_PAGES_TOTAL_MISMATCH: expected 12, got 13');
  return { props: { initialValue: 12 } };
}
