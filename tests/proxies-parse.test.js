/**
 * Proxy list parsing.
 *
 * `parseList` is the only part of proxies/service.js that is pure - it takes
 * pasted text and returns rows, with no database and no socket. The module
 * around it is not: the top of the file imports the database, the settings
 * table and the logger, so `node:sqlite` has to resolve and the import chain
 * has to be intact before this file can run. That is true inside Electron and
 * may not be true under plain `node --test`, so the import is attempted once
 * here and every test is skipped, with the reason, when it fails. Nothing is
 * stubbed or worked around - a test that quietly tests a copy of the parser
 * would be worse than no test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

let parseList = null;
let loadError = null;

try {
  ({ parseList } = await import('../src/backend/proxies/service.js'));
} catch (err) {
  loadError = err;
}

const skip = loadError
  ? { skip: `src/backend/proxies/service.js cannot be loaded here: ${loadError.message}` }
  : {};

// ---------------------------------------------------------------- formats

test('host:port', skip, () => {
  const { valid } = parseList('1.2.3.4:1080');
  assert.equal(valid.length, 1);
  assert.deepEqual({ ...valid[0], line: undefined }, {
    host: '1.2.3.4', port: 1080, username: '', password: '', protocol: 'socks5', line: undefined
  });
});

test('host:port:user:pass', skip, () => {
  const { valid } = parseList('proxy.example:1080:alice:s3cret');
  assert.equal(valid[0].host, 'proxy.example');
  assert.equal(valid[0].port, 1080);
  assert.equal(valid[0].username, 'alice');
  assert.equal(valid[0].password, 's3cret');
});

test('user:pass@host:port', skip, () => {
  const { valid } = parseList('alice:s3cret@proxy.example:1080');
  assert.equal(valid[0].host, 'proxy.example');
  assert.equal(valid[0].port, 1080);
  assert.equal(valid[0].username, 'alice');
  assert.equal(valid[0].password, 's3cret');
});

test('a password containing a colon survives the split', skip, () => {
  const { valid } = parseList('alice:pa:ss@proxy.example:1080');
  assert.equal(valid[0].username, 'alice');
  assert.equal(valid[0].password, 'pa:ss');
  assert.equal(valid[0].port, 1080);
});

test('user@host:port with no password', skip, () => {
  const { valid } = parseList('alice@proxy.example:1080');
  assert.equal(valid[0].username, 'alice');
  assert.equal(valid[0].password, '');
});

test('scheme://user:pass@host:port', skip, () => {
  const { valid } = parseList('socks5://alice:s3cret@proxy.example:1080');
  assert.equal(valid[0].protocol, 'socks5');
  assert.equal(valid[0].host, 'proxy.example');
  assert.equal(valid[0].username, 'alice');
  assert.equal(valid[0].password, 's3cret');
});

test('the scheme decides the protocol', skip, () => {
  const cases = [
    ['socks5://1.2.3.4:1080', 'socks5'],
    ['socks5h://1.2.3.4:1080', 'socks5'],
    ['socks4://1.2.3.4:1080', 'socks4'],
    ['socks4a://1.2.3.4:1080', 'socks4'],
    ['http://1.2.3.4:1080', 'http'],
    ['https://1.2.3.4:1080', 'http']
  ];
  for (const [line, expected] of cases) {
    assert.equal(parseList(line).valid[0].protocol, expected, line);
  }
});

test('host port user pass, whitespace separated', skip, () => {
  const { valid } = parseList('proxy.example 1080 alice s3cret');
  assert.equal(valid[0].host, 'proxy.example');
  assert.equal(valid[0].port, 1080);
  assert.equal(valid[0].username, 'alice');
  assert.equal(valid[0].password, 's3cret');
});

test('host port with no credentials', skip, () => {
  const { valid } = parseList('proxy.example 1080');
  assert.equal(valid[0].host, 'proxy.example');
  assert.equal(valid[0].port, 1080);
  assert.equal(valid[0].username, '');
});

test('the default protocol is used when the line does not name one', skip, () => {
  assert.equal(parseList('1.2.3.4:1080', { protocol: 'http' }).valid[0].protocol, 'http');
  assert.equal(parseList('1.2.3.4:1080').valid[0].protocol, 'socks5');
});

test('the protocol list is the one the rest of the app validates against', skip, () => {
  for (const line of ['1.2.3.4:1080', 'http://1.2.3.4:1080', 'socks4://1.2.3.4:1080']) {
    assert.ok(['socks5', 'socks4', 'http'].includes(parseList(line).valid[0].protocol), line);
  }
});

// ---------------------------------------------------------------- comments

test('comments and blank lines are ignored but still counted as lines', skip, () => {
  const text = ['# provider one', '// a second comment style', '', '1.2.3.4:1080'].join('\n');
  const { valid, invalid, counts } = parseList(text);

  assert.equal(valid.length, 1);
  assert.equal(invalid.length, 0);
  assert.equal(counts.total, 1);
  // The line number is the line in the pasted text, so an error points at the
  // right row of the textarea.
  assert.equal(valid[0].line, 4);
});

test('CRLF line endings parse the same as LF', skip, () => {
  const { valid } = parseList('1.2.3.4:1080\r\nalice:s3cret@5.6.7.8:1080\r\n');
  assert.equal(valid.length, 2);
  assert.equal(valid[1].host, '5.6.7.8');
});

test('an empty or missing list is empty rather than an error', skip, () => {
  assert.deepEqual(parseList('').valid, []);
  assert.deepEqual(parseList(null).valid, []);
  assert.deepEqual(parseList(undefined).valid, []);
  assert.deepEqual(parseList('').counts, { total: 0, valid: 0, invalid: 0 });
});

// ---------------------------------------------------------------- duplicates

test('a repeated line is reported instead of imported twice', skip, () => {
  const { valid, invalid } = parseList('1.2.3.4:1080\n1.2.3.4:1080');
  assert.equal(valid.length, 1);
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].reason, 'duplicate in this list');
  assert.equal(invalid[0].line, 2);
});

test('the same endpoint on a different protocol is not a duplicate', skip, () => {
  const { valid, invalid } = parseList('1.2.3.4:1080\nsocks4://1.2.3.4:1080');
  assert.equal(valid.length, 2);
  assert.equal(invalid.length, 0);
});

test('the same endpoint with a different username is not a duplicate', skip, () => {
  const { valid } = parseList('alice:pw@1.2.3.4:1080\nbob:pw@1.2.3.4:1080');
  assert.equal(valid.length, 2);
});

// ---------------------------------------------------------------- invalid lines

test('a port outside the valid range is rejected', skip, () => {
  for (const line of ['1.2.3.4:0', '1.2.3.4:70000', '1.2.3.4:-1']) {
    const { valid, invalid } = parseList(line);
    assert.equal(valid.length, 0, line);
    assert.equal(invalid[0].reason, 'invalid port', line);
  }
});

test('a port that is not a number is rejected', skip, () => {
  for (const line of ['1.2.3.4:abc', '1.2.3.4:', 'proxy.example port']) {
    const { invalid } = parseList(line);
    assert.equal(invalid[0].reason, 'invalid port', line);
  }
});

test('a line with no host is rejected', skip, () => {
  const { invalid } = parseList('noseparator');
  assert.equal(invalid[0].reason, 'missing host');
});

test('a rejected line reports where it came from', skip, () => {
  const { invalid } = parseList('1.2.3.4:1080\n1.2.3.4:99999');
  assert.equal(invalid[0].line, 2);
  assert.equal(invalid[0].text, '1.2.3.4:99999');
});

test('the counts add up across a mixed list', skip, () => {
  const text = [
    '# a mixed list',
    '1.2.3.4:1080',
    '1.2.3.4:1080',
    '1.2.3.4:99999',
    'alice:pw@5.6.7.8:1080'
  ].join('\n');

  const { valid, invalid, counts } = parseList(text);
  assert.equal(valid.length, 2);
  assert.equal(invalid.length, 2);
  assert.equal(counts.total, 4);
  assert.equal(counts.valid, 2);
  assert.equal(counts.invalid, 2);
});
