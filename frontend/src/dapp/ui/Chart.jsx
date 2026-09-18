// Placeholder until Task 13 replaces this file. Same props as the real chart.
export default function Chart({ interval }) {
  return (
    <section className="pane chart-pane" aria-label="Chart">
      <div className="chart-box" data-interval={interval} />
    </section>
  );
}
