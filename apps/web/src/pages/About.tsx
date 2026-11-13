export function About() {
  return (
    <main className="card about">
      <p className="wordmark">Backroom</p>
      <h1>About Backroom</h1>
      <p>
        <span>Emoji graphics by Twemoji, CC-BY 4.0</span> (
        <a href="https://github.com/jdecked/twemoji" target="_blank" rel="noopener noreferrer">
          Twemoji project
        </a>
        ,{' '}
        <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer license">
          CC-BY 4.0 licence
        </a>
        ).
      </p>
      <p>Emoji data from emoji-datasource (MIT).</p>
      <p>
        <a href="/">Back to chat</a>
      </p>
    </main>
  );
}
