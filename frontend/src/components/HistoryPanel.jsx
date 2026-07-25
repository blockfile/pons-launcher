import Section from './Section.jsx';

export default function HistoryPanel({ entries, explorer }) {
  if (!entries.length) {
    return (
      <Section title="History">
        <div className="history">no launches yet</div>
      </Section>
    );
  }

  return (
    <Section title="History">
      <div className="history">
        {entries.map((e) => {
          const filled = e.buys.filter((b) => b.status === 'confirmed').length;
          return (
            <div key={e.at}>
              {e.at.replace('T', ' ').slice(0, 19)} ·{' '}
              <a href={`${explorer}/address/${e.token}`} target="_blank" rel="noopener noreferrer">
                {e.params?.symbol || e.token}
              </a>{' '}
              · dev {e.devBuyEth} + bundle {e.totalBuyEth} ETH · {filled}/{e.buys.length} filled
              {e.sameBlock ? ` · ${e.sameBlock} same-block` : ''}
              {e.dryRun ? ' · DRY RUN' : ''}
            </div>
          );
        })}
      </div>
    </Section>
  );
}
