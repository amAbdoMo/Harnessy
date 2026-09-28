"""Local, revisioned translation reference data; evidence claims are not authenticated.

Uses only Python's standard library. Reads never create a missing store. Writes
use an expected revision and a transaction; no operation accesses WordPress.
"""

import argparse
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
from datetime import datetime, timezone
from urllib.parse import urlsplit, urlunsplit

SCHEMA_VERSION = 1
MAX_OUTPUT_BYTES = 65536


def text(value, field, maximum, allow_empty=False):
    """Validate bounded text before it enters storage or a query."""
    if not isinstance(value, str) or len(value) > maximum or (not allow_empty and not value.strip()):
        raise ValueError(f"{field} must be {'0' if allow_empty else '1'}..{maximum} characters")
    return value


def site_url(value):
    """Normalize origin casing and trailing slash while preserving installation paths."""
    text(value, 'site', 500)
    parsed = urlsplit(value)
    if (parsed.scheme not in ('https', 'http') or not parsed.hostname or
            parsed.username is not None or parsed.password is not None or
            parsed.query or parsed.fragment or any(c.isspace() for c in value) or '\\' in value):
        raise ValueError('site must be an absolute HTTP(S) URL without credentials, query, or fragment')
    host = parsed.hostname.lower()
    if ':' in host:
        host = f'[{host}]'
    port = parsed.port
    if port == 0:
        raise ValueError('site port must be 1..65535')
    if port is not None and (parsed.scheme, port) not in (('https', 443), ('http', 80)):
        host += f':{port}'
    if any(segment in ('.', '..') for segment in parsed.path.split('/')):
        raise ValueError('site path must not contain dot segments')
    return urlunsplit((parsed.scheme, host, parsed.path.rstrip('/'), '', ''))


def identifier(value):
    """Accept stable semantic IDs suitable for human references."""
    if not isinstance(value, str) or not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', value) or len(value) > 100:
        raise ValueError('id must be 1..100 lowercase kebab-case characters')
    return value


def language_code(value):
    """Normalize optional language codes consistently for records and searches."""
    if value is None:
        return None
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,34}', value):
        raise ValueError('invalid language code')
    return value.lower()


def record_data(raw, allow_retired=False):
    """Validate external records, including declared activation evidence."""
    required = {'id', 'kind', 'scope', 'provider', 'title', 'text', 'evidence', 'status', 'tags'}
    optional = {'site', 'language', 'retirement_reason'}
    if not isinstance(raw, dict) or not required <= raw.keys() or raw.keys() - required - optional:
        raise ValueError('record has missing or unknown fields')
    result = dict(raw)
    identifier(result['id'])
    if result['kind'] not in ('preference', 'procedure', 'glossary', 'site-profile'):
        raise ValueError('invalid kind')
    if result['scope'] not in ('site', 'global'):
        raise ValueError('invalid scope')
    if result['provider'] not in ('wpml', 'polylang', 'other', 'any'):
        raise ValueError('invalid provider')
    if result['status'] not in (('candidate', 'active', 'retired') if allow_retired else ('candidate', 'active')):
        raise ValueError('invalid status')
    if 'retirement_reason' in result:
        if result['status'] != 'retired':
            raise ValueError('retirement_reason is only valid for retired records')
        text(result['retirement_reason'], 'retirement reason', 500)
    result['site'] = site_url(result.get('site')) if result['scope'] == 'site' else None
    if result['scope'] == 'global' and raw.get('site') is not None:
        raise ValueError('global records cannot name a site')
    result['language'] = language_code(result.get('language'))
    text(result['title'], 'title', 160)
    text(result['text'], 'text', 6000)
    tags = result['tags']
    if not isinstance(tags, list) or len(tags) > 12:
        raise ValueError('tags must be a list of at most 12 values')
    result['tags'] = sorted({identifier(tag) for tag in tags})
    evidence = result['evidence']
    if not isinstance(evidence, list) or not 1 <= len(evidence) <= 6:
        raise ValueError('evidence must contain 1..6 entries')
    for item in evidence:
        if not isinstance(item, dict) or set(item) != {'type', 'reference', 'note'}:
            raise ValueError('each evidence item needs type, reference, note')
        if item['type'] not in ('user', 'verification', 'external'):
            raise ValueError('invalid evidence type')
        text(item['reference'], 'evidence reference', 300)
        text(item['note'], 'evidence note', 500)
    if result['status'] == 'active':
        needed = 'user' if result['kind'] in ('preference', 'glossary') else 'verification'
        if not any(item['type'] == needed for item in evidence):
            raise ValueError(f'active {result["kind"]} requires declared {needed} evidence')
    return result


def store_path(argument):
    """Resolve a shared user store independently of the current project."""
    if argument:
        path = Path(argument)
    else:
        home = os.environ.get('WP_TRANSLATION_MEMORY_HOME')
        path = (Path(home) if home else Path.home() / '.agents' / 'knowledge' / 'wp-translation') / 'knowledge.sqlite3'
    if not path.is_absolute():
        raise ValueError('store and WP_TRANSLATION_MEMORY_HOME must be absolute paths')
    return path


def connect(path, write=False):
    """Open an existing schema, or initialize one inside a write transaction."""
    if not write and not path.exists():
        return None
    created_here = False
    if write:
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            with path.open('xb'):
                created_here = True
        except FileExistsError:
            pass  # Existing stores must pass schema validation; never reset them.
    db = sqlite3.connect(path if write else path.as_uri() + '?mode=ro', uri=not write, timeout=5)
    try:
        db.execute('PRAGMA foreign_keys=ON')
        try:
            db.execute("SELECT json_extract('{\"ok\":1}', '$.ok')").fetchone()
        except sqlite3.OperationalError as error:
            raise ValueError('SQLite JSON support is required; use the bundled Python interpreter') from error
        if write:
            db.execute('BEGIN IMMEDIATE')
        version = db.execute('PRAGMA user_version').fetchone()[0]
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if write and created_here and version == 0 and not tables:
            db.execute("CREATE TABLE revisions (id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=65536 AND json_valid(body) AND json_extract(body,'$.id')=id), created TEXT NOT NULL, PRIMARY KEY(id, revision))")
            db.execute('CREATE TABLE heads (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, FOREIGN KEY(id,revision) REFERENCES revisions(id,revision))')
            db.execute(f'PRAGMA user_version={SCHEMA_VERSION}')
            db.commit()
            db.execute('BEGIN IMMEDIATE')
        elif version != SCHEMA_VERSION or not {'heads', 'revisions'} <= tables:
            raise ValueError(f'unsupported or malformed store schema: {version}; expected {SCHEMA_VERSION}')
        validate_store(db)
        return db
    except Exception:
        db.close()
        raise


def validate_store(db):
    """Reject structural corruption before queries can hide dangling records."""
    expected = {'heads': [('id', 'TEXT', 1), ('revision', 'INTEGER', 0)],
                'revisions': [('id', 'TEXT', 1), ('revision', 'INTEGER', 2), ('body', 'TEXT', 0), ('created', 'TEXT', 0)]}
    for table, columns in expected.items():
        actual = [(row[1], row[2], row[5]) for row in db.execute(f'PRAGMA table_info({table})')]
        if actual != columns:
            raise ValueError(f'malformed {table} columns or primary key')
    if db.execute('PRAGMA quick_check(1)').fetchone()[0] != 'ok':
        raise ValueError('SQLite integrity check failed; restore a known-good backup')
    broken = db.execute('SELECT h.id FROM heads h LEFT JOIN revisions r ON h.id=r.id AND h.revision=r.revision WHERE r.id IS NULL LIMIT 1').fetchone()
    orphan = db.execute('SELECT r.id FROM revisions r LEFT JOIN heads h ON r.id=h.id WHERE h.id IS NULL OR r.revision>h.revision LIMIT 1').fetchone()
    if broken or orphan:
        raise ValueError('malformed revision history: missing or stale head')
    if db.execute('PRAGMA foreign_key_check').fetchone():
        raise ValueError('revision history violates foreign keys')


def decoded_record(body):
    """Bound durable text before decoding, then validate the selected record."""
    if not isinstance(body, str) or len(body.encode('utf-8')) > MAX_OUTPUT_BYTES:
        raise ValueError('stored record exceeds 65536 bytes')
    return record_data(json.loads(body), allow_retired=True)


def current(db, item_id, revision=None):
    """Read a validated revision without returning data from other records."""
    identifier(item_id)
    if db is None:
        raise ValueError(f'record not found: {item_id}')
    if revision is None:
        row = db.execute('SELECT r.revision,r.body,r.created FROM revisions r JOIN heads h ON r.id=h.id AND r.revision=h.revision WHERE r.id=?', (item_id,)).fetchone()
    else:
        row = db.execute('SELECT revision,body,created FROM revisions WHERE id=? AND revision=?', (item_id, revision)).fetchone()
    if row is None:
        raise ValueError(f'record/revision not found: {item_id}')
    data = decoded_record(row[1])
    if data['id'] != item_id:
        raise ValueError('stored record ID mismatch')
    return {'revision': row[0], 'created': row[2], 'record': data}


def save(db, data, expected):
    """Append one immutable revision with compare-and-swap semantics."""
    row = db.execute('SELECT revision FROM heads WHERE id=?', (data['id'],)).fetchone()
    actual = row[0] if row else 0
    if expected != actual:
        raise ValueError(f'revision conflict: expected {expected}, current {actual}; re-read and reconcile')
    revision = actual + 1
    created = datetime.now(timezone.utc).isoformat()
    db.execute('INSERT INTO revisions VALUES (?,?,?,?)', (data['id'], revision, json.dumps(data, ensure_ascii=False), created))
    db.execute('INSERT INTO heads VALUES (?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision', (data['id'], revision))
    db.commit()
    return {'id': data['id'], 'revision': revision, 'scope': data['scope'], 'site': data['site'], 'status': data['status']}


def search(db, args):
    """Select applicable heads; never retrieve another site's lessons."""
    site = site_url(args.site)
    tags = [identifier(tag) for tag in args.tags.split(',') if tag]
    if len(tags) > 12:
        raise ValueError('at most 12 query tags are allowed')
    query = text(args.query, 'query', 200, allow_empty=True)
    language = language_code(args.language)
    if db is None:
        return {'items': [], 'more': False}
    conditions = ["(json_extract(r.body,'$.scope')='global' OR json_extract(r.body,'$.site')=?)", "json_extract(r.body,'$.provider') IN (?, 'any')", "(json_extract(r.body,'$.language') IS NULL OR json_extract(r.body,'$.language')=?)"]
    values = [site, args.provider, language]
    conditions.append("json_extract(r.body,'$.status') IN ('active','candidate')" if args.include_candidates else "json_extract(r.body,'$.status')='active'")
    if tags:
        conditions.append("EXISTS (SELECT 1 FROM json_each(r.body,'$.tags') WHERE value IN (" + ','.join('?' for _ in tags) + '))')
        values.extend(tags)
    if query:
        conditions.append("instr(lower(json_extract(r.body,'$.title') || ' ' || json_extract(r.body,'$.text')),lower(?))>0")
        values.append(query)
    rows = db.execute('SELECT r.id,r.revision,r.body FROM revisions r JOIN heads h ON r.id=h.id AND r.revision=h.revision WHERE ' + ' AND '.join(conditions) + " ORDER BY (json_extract(r.body,'$.scope')='site') DESC,r.id LIMIT ?", (*values, args.limit + 1)).fetchall()
    items = []
    for item_id, revision, body in rows[:args.limit]:
        data = decoded_record(body)
        if data['id'] != item_id:
            raise ValueError('stored record ID mismatch')
        items.append({'id': item_id, 'revision': revision, 'kind': data['kind'], 'scope': data['scope'], 'status': data['status'], 'title': data['title'], 'summary': data['text'][:180]})
    return {'items': items, 'more': len(rows) > args.limit}


def bounded_integer(value):
    """Parse a retrieval limit, rejecting silent truncation of invalid requests."""
    result = int(value)
    if not 1 <= result <= 30:
        raise argparse.ArgumentTypeError('limit must be 1..30')
    return result


def nonnegative(value):
    """Parse optimistic revisions, including zero for a new record."""
    result = int(value)
    if result < 0:
        raise argparse.ArgumentTypeError('revision must be nonnegative')
    return result


class JsonArgumentParser(argparse.ArgumentParser):
    """Route argument errors through the CLI's bounded JSON error output."""

    def error(self, message):
        raise ValueError(message)


def parser():
    """Describe the portable CLI; no command authorizes a WordPress mutation."""
    root = JsonArgumentParser(description=__doc__)
    root.add_argument('--store', help='Absolute SQLite file; overrides the shared local default')
    commands = root.add_subparsers(dest='command', required=True)
    find = commands.add_parser('search')
    find.add_argument('--site', required=True)
    find.add_argument('--provider', choices=['wpml', 'polylang', 'other'], required=True)
    find.add_argument('--tags', default='')
    find.add_argument('--language')
    find.add_argument('--query', default='')
    find.add_argument('--limit', type=bounded_integer, default=8)
    find.add_argument('--include-candidates', action='store_true')
    get = commands.add_parser('get')
    get.add_argument('id')
    get.add_argument('--revision', type=nonnegative)
    put = commands.add_parser('save')
    put.add_argument('--input', required=True, help='UTF-8 JSON record, not a transcript')
    put.add_argument('--expected-revision', type=nonnegative, required=True)
    put.add_argument('--allow-global', action='store_true', help='Confirm explicitly intended cross-site scope')
    retire = commands.add_parser('retire')
    retire.add_argument('id')
    retire.add_argument('--expected-revision', type=nonnegative, required=True)
    retire.add_argument('--reason', required=True)
    history = commands.add_parser('history')
    history.add_argument('id')
    history.add_argument('--limit', type=bounded_integer, default=8)
    export = commands.add_parser('export', help='Write all history, potentially private; does not upload it')
    export.add_argument('--output', required=True, help='New absolute output file, never overwritten')
    commands.add_parser('status')
    return root


def run(args):
    """Dispatch one local operation; all connections close on success or failure."""
    path = store_path(args.store)
    data = None
    if args.command == 'save':
        source = Path(args.input)
        with source.open('rb') as input_file:
            content = input_file.read(MAX_OUTPUT_BYTES + 1)
        if len(content) > MAX_OUTPUT_BYTES:
            raise ValueError('input exceeds 65536 bytes')
        data = record_data(json.loads(content.decode('utf-8-sig')))
        if data['scope'] == 'global' and not args.allow_global:
            raise ValueError('global scope requires explicit --allow-global')
        if args.expected_revision != 0 and not path.exists():
            raise ValueError('revision conflict: store does not exist; new records require revision 0')
    if args.command == 'retire':
        text(args.reason, 'reason', 500)
        identifier(args.id)
        if not path.exists():
            raise ValueError(f'record not found: {args.id}')
    db = connect(path, write=args.command in ('save', 'retire'))
    try:
        if args.command == 'status':
            count = db.execute('SELECT count(*) FROM heads').fetchone()[0] if db else 0
            return {'store': str(path), 'exists': db is not None, 'schema_version': SCHEMA_VERSION, 'records': count}
        if args.command == 'search':
            return search(db, args)
        if args.command == 'get':
            return current(db, args.id, args.revision)
        if args.command == 'save':
            return save(db, data, args.expected_revision)
        if args.command == 'retire':
            data = current(db, args.id)['record']
            data['status'] = 'retired'
            data['retirement_reason'] = args.reason
            return save(db, data, args.expected_revision)
        if args.command == 'history':
            identifier(args.id)
            rows = db.execute('SELECT revision,created FROM revisions WHERE id=? ORDER BY revision DESC LIMIT ?', (args.id, args.limit + 1)).fetchall() if db else []
            return {'id': args.id, 'items': [{'revision': row[0], 'created': row[1]} for row in rows[:args.limit]], 'more': len(rows) > args.limit}
        destination = Path(args.output)
        if not destination.is_absolute() or destination.resolve() == path.resolve():
            raise ValueError('export output must be a new absolute path distinct from the store')
        count = 0
        with destination.open('x', encoding='utf-8', newline='\n') as output:
            try:
                if db:
                    for item_id, revision, body, created in db.execute('SELECT id,revision,body,created FROM revisions ORDER BY id,revision'):
                        record = decoded_record(body)
                        if record['id'] != item_id:
                            raise ValueError('stored record ID mismatch')
                        output.write(json.dumps({'schema_version': SCHEMA_VERSION, 'revision': revision, 'created': created, 'record': record}, ensure_ascii=False) + '\n')
                        count += 1
            except Exception:
                output.close()
                destination.unlink()
                raise
        return {'output': str(destination), 'revisions': count, 'warning': 'Contains all stored history; review private content before sharing.'}
    finally:
        if db:
            db.close()


def main(argv=None):
    """Emit bounded JSON and return a nonzero exit for failed operations."""
    try:
        args = parser().parse_args(argv)
        result = run(args)
        encoded = json.dumps(result, ensure_ascii=False)
        if len(encoded.encode('utf-8')) > MAX_OUTPUT_BYTES:
            raise ValueError('result exceeds 65536 bytes; request fewer items')
        print(encoded)
        return 0
    except (ValueError, TypeError, OSError, sqlite3.Error) as error:
        print(json.dumps({'error': str(error)[:1000]}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
