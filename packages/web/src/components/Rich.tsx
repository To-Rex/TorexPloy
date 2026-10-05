/** Inline markup for documentation text: `**bold**`, `` `code` `` and `[label](/route)` links into the dashboard. */
import { Link } from 'react-router';

const TOKEN = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
const LINK = /^\[([^\]]+)\]\(([^)]+)\)$/;

export function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split(TOKEN).map((part, index) => {
        if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
        if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>;
        const link = LINK.exec(part);
        if (link !== null) {
          const to = link[2]!;
          if (/^https?:\/\//.test(to)) {
            return (
              <a key={index} href={to} target="_blank" rel="noreferrer noopener">
                {link[1]}
              </a>
            );
          }
          return (
            <Link key={index} to={to}>
              {link[1]}
            </Link>
          );
        }
        return part;
      })}
    </>
  );
}
