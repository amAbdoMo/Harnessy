"""Behavior checks using isolated real SQLite stores, never the shared user store."""

from contextlib import closing, redirect_stdout, redirect_stderr
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'memory.py'
SPEC = importlib.util.spec_from_file_location('translation_memory', SCRIPT)
memory = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(memory)


class MemoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = self.root / 'knowledge.sqlite3'

    def call(self, *arguments, succeeds=True):
        output, errors = io.StringIO(), io.StringIO()
        with redirect_stdout(output), redirect_stderr(errors):
            code = memory.main(['--store', str(self.store), *arguments])
        self.assertEqual(code, 0 if succeeds else 1, errors.getvalue())
        return json.loads(output.getvalue() if succeeds else errors.getvalue())

    def lesson(self, item_id='menu-rule', **changes):
        value = {'id': item_id, 'kind': 'preference', 'scope': 'site',
                 'site': 'https://example.test/shop', 'provider': 'wpml', 'language': None,
                 'tags': ['menus'], 'title': 'Menu preference', 'text': 'Use linked menus.',
                 'status': 'active', 'evidence': [{'type': 'user', 'reference': 'test correction', 'note': 'Explicit site preference.'}]}
        value.update(changes)
        return value

    def put(self, value, revision=0, global_scope=False, succeeds=True):
        source = self.root / 'input.json'
        source.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
        flags = ['--allow-global'] if global_scope else []
        return self.call('save', '--input', str(source), '--expected-revision', str(revision), *flags, succeeds=succeeds)

    def find(self, *arguments):
        return self.call('search', '--site', 'https://example.test/shop', '--provider', 'wpml', *arguments)

    def test_missing_reads_do_not_create_store(self):
        self.assertFalse(self.call('status')['exists'])
        self.assertEqual(self.find()['items'], [])
        self.assertEqual(self.call('history', 'missing')['items'], [])
        self.call('get', 'missing', succeeds=False)
        self.call('retire', 'missing', '--expected-revision', '0', '--reason', 'obsolete', succeeds=False)
        self.assertFalse(self.store.exists())

    def test_revision_conflict_preserves_history_and_restore_appends(self):
        self.assertEqual(self.put(self.lesson())['revision'], 1)
        self.assertEqual(self.put(self.lesson(text='Use synced menus.'), 1)['revision'], 2)
        error = self.put(self.lesson(text='Stale overwrite.'), 1, succeeds=False)
        self.assertIn('conflict', error['error'])
        self.assertEqual(self.call('get', 'menu-rule')['record']['text'], 'Use synced menus.')
        old = self.call('get', 'menu-rule', '--revision', '1')['record']
        self.assertEqual(self.put(old, 2)['revision'], 3)
        self.call('retire', 'menu-rule', '--expected-revision', '3', '--reason', 'new policy')
        self.assertEqual(self.find()['items'], [])
        self.assertEqual(self.call('get', 'menu-rule', '--revision', '1')['record'], old)
        self.assertEqual(self.put(old, 4)['revision'], 5)
        history = self.call('history', 'menu-rule', '--limit', '2')
        self.assertEqual([item['revision'] for item in history['items']], [5, 4])
        self.assertTrue(history['more'])

    def test_search_isolates_site_provider_language_and_status(self):
        records = [self.lesson(), self.lesson('other-install', site='https://example.test/blog'),
                   self.lesson('other-provider', provider='polylang'), self.lesson('arabic', language='ar'),
                   self.lesson('candidate', status='candidate'), self.lesson('universal', scope='global', site=None, provider='any')]
        for record in records:
            self.put(record, global_scope=record['scope'] == 'global')
        self.assertEqual([r['id'] for r in self.find()['items']], ['menu-rule', 'universal'])
        self.assertEqual([r['id'] for r in self.find('--language', 'ar')['items']], ['arabic', 'menu-rule', 'universal'])
        self.assertIn('candidate', [r['id'] for r in self.find('--include-candidates')['items']])
        self.assertEqual(self.find('--tags', 'checkout')['items'], [])
        self.assertEqual(len(self.find('--tags', 'checkout,menus')['items']), 2)
        self.assertEqual(self.find('--query', 'no-match')['items'], [])
        self.assertEqual(len(self.find('--query', 'LINKED')['items']), 2)

    def test_global_scope_and_active_evidence_require_explicit_inputs(self):
        for changes in [{'scope': 'global', 'site': None}, {'kind': 'procedure'}, {'kind': 'site-profile'},
                        {'evidence': [{'type': 'external', 'reference': 'web', 'note': 'Claim'}]}]:
            with self.subTest(changes=changes):
                self.put(self.lesson(**changes), succeeds=False)
                self.assertFalse(self.store.exists())
        self.put(self.lesson('candidate-procedure', kind='procedure', status='candidate'))
        self.put(self.lesson('verified-procedure', kind='procedure', evidence=[{'type': 'verification', 'reference': 'read-back', 'note': 'Observed result'}]))
        self.assertEqual([r['id'] for r in self.find()['items']], ['verified-procedure'])

    def test_url_normalization_preserves_installation_identity(self):
        self.put(self.lesson(site='https://EXAMPLE.test:443/shop/'))
        self.assertEqual(len(self.find()['items']), 1)
        self.assertEqual(self.call('search', '--site', 'https://example.test/shop2', '--provider', 'wpml')['items'], [])
        for site in ['https://u:p@example.test/shop', 'https://example.test/shop?a=b', 'https://example.test/shop#x', 'https://example.test/a/../shop', 'file:///shop', 'https://example.test:bad/shop']:
            with self.subTest(site=site):
                self.put(self.lesson(site=site), 1, succeeds=False)
        self.assertEqual(self.call('get', 'menu-rule')['revision'], 1)

    def test_validation_rejects_oversized_or_malformed_records(self):
        for changes in [{'text': 'x' * 6001}, {'tags': ['Bad tag']}, {'evidence': []}, {'language': []}, {'title': None}, {'unknown': True}, {'scope': []}]:
            with self.subTest(changes=changes):
                self.put(self.lesson(**changes), succeeds=False)
                self.assertFalse(self.store.exists())

    def test_search_output_is_bounded_and_reports_more(self):
        for index in range(31):
            self.put(self.lesson(f'rule-{index}', title='م' * 160, text='م' * 6000))
        result = self.find('--limit', '30')
        self.assertEqual(len(result['items']), 30)
        self.assertTrue(result['more'])
        self.assertLess(len(json.dumps(result, ensure_ascii=False).encode('utf-8')), memory.MAX_OUTPUT_BYTES)
        self.assertLess(len(result['items'][0]['summary']), 200)
        self.assertNotIn('evidence', result['items'][0])

    def test_future_or_corrupt_store_fails_without_reset(self):
        self.put(self.lesson())
        with closing(sqlite3.connect(self.store)) as db:
            db.execute('PRAGMA user_version=999')
        self.call('status', succeeds=False)
        self.put(self.lesson(), 1, succeeds=False)
        with closing(sqlite3.connect(self.store)) as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 999)
            self.assertEqual(db.execute('SELECT count(*) FROM revisions').fetchone()[0], 1)
        self.store.write_bytes(b'not a database')
        self.call('status', succeeds=False)
        self.assertEqual(self.store.read_bytes(), b'not a database')

    def test_first_save_conflict_does_not_create_a_malformed_store(self):
        self.put(self.lesson(), revision=1, succeeds=False)
        self.assertFalse(self.store.exists())
        self.assertFalse(self.call('status')['exists'])
        self.assertEqual(self.put(self.lesson())['revision'], 1)

    def test_maximum_text_can_be_retired_without_losing_content(self):
        original = self.lesson(text='😀' * 6000)
        self.put(original)
        self.call('retire', 'menu-rule', '--expected-revision', '1', '--reason', 'Replaced')
        retired = self.call('get', 'menu-rule')['record']
        self.assertEqual(retired['text'], original['text'])
        self.assertEqual(retired['retirement_reason'], 'Replaced')
        self.assertEqual(retired['status'], 'retired')

    def test_dangling_head_is_reported_instead_of_empty_search(self):
        self.put(self.lesson())
        with closing(sqlite3.connect(self.store)) as db:
            db.execute('UPDATE heads SET revision=99')
            db.commit()
        for arguments in [('status',), ('search', '--site', 'https://example.test/shop', '--provider', 'wpml'), ('get', 'menu-rule')]:
            with self.subTest(arguments=arguments):
                self.assertIn('head', self.call(*arguments, succeeds=False)['error'])

    def test_malformed_columns_and_invalid_stored_json_fail(self):
        self.put(self.lesson())
        with closing(sqlite3.connect(self.store)) as db:
            db.execute('PRAGMA ignore_check_constraints=ON')
            db.execute("UPDATE revisions SET body='invalid json'")
            db.commit()
        self.call('get', 'menu-rule', succeeds=False)
        with closing(sqlite3.connect(self.store)) as db:
            db.execute('ALTER TABLE heads ADD COLUMN unexpected TEXT')
        self.assertIn('columns', self.call('status', succeeds=False)['error'])

    def test_input_byte_limit_is_checked_on_the_read_content(self):
        source = self.root / 'bounded.json'
        content = json.dumps(self.lesson()).encode('utf-8')
        source.write_bytes(content + b' ' * (memory.MAX_OUTPUT_BYTES - len(content)))
        self.call('save', '--input', str(source), '--expected-revision', '0')
        with source.open('ab') as output:
            output.write(b' ')
        self.assertIn('exceeds', self.call('save', '--input', str(source), '--expected-revision', '1', succeeds=False)['error'])
        self.assertEqual(self.call('get', 'menu-rule')['revision'], 1)

    def test_zero_and_nondefault_ports_do_not_merge_site_identity(self):
        self.put(self.lesson(site='https://example.test:0/shop'), succeeds=False)
        self.put(self.lesson(site='https://example.test:8443/shop'))
        self.assertEqual(self.find()['items'], [])
        self.assertEqual(len(self.call('search', '--site', 'https://example.test:8443/shop', '--provider', 'wpml')['items']), 1)

    def test_argument_errors_are_bounded_json(self):
        for arguments in [('search',), ('search', '--site', 'https://example.test', '--provider', 'wpml', '--limit', '31'), ('get', 'menu-rule', '--revision', '-1'), ('unknown',)]:
            with self.subTest(arguments=arguments):
                self.assertIn('error', self.call(*arguments, succeeds=False))
                self.assertFalse(self.store.exists())

    def test_interrupted_empty_store_is_not_silently_initialized(self):
        self.store.touch()
        self.call('status', succeeds=False)
        self.put(self.lesson(), succeeds=False)
        self.assertEqual(self.store.read_bytes(), b'')

    def test_malformed_search_language_does_not_return_neutral_lessons(self):
        self.put(self.lesson())
        for language in ('', 'Arabic please', 'a' * 36):
            with self.subTest(language=language):
                self.call('search', '--site', 'https://example.test/shop', '--provider', 'wpml', '--language', language, succeeds=False)

    def test_concurrent_expected_revision_allows_one_writer(self):
        self.put(self.lesson())
        barrier = Barrier(2, timeout=10)
        requests = []
        for index in range(2):
            source = self.root / f'writer-{index}.json'
            source.write_text(json.dumps(self.lesson(text=f'Writer {index}')), encoding='utf-8')
            requests.append(memory.parser().parse_args(['--store', str(self.store), 'save', '--input', str(source), '--expected-revision', '1']))

        def attempt(request):
            barrier.wait()
            try:
                return memory.run(request)
            except ValueError as error:
                return {'error': str(error)}

        with ThreadPoolExecutor(max_workers=2) as writers:
            outcomes = list(writers.map(attempt, requests))
        self.assertEqual(sum('revision' in outcome for outcome in outcomes), 1)
        self.assertEqual(sum('conflict' in outcome.get('error', '') for outcome in outcomes), 1)
        self.assertEqual(self.call('get', 'menu-rule')['revision'], 2)
        self.assertEqual(len(self.call('history', 'menu-rule')['items']), 2)

    def test_export_preserves_all_revisions_and_refuses_overwrite(self):
        self.put(self.lesson())
        self.put(self.lesson(text='Updated'), 1)
        output = self.root / 'history.jsonl'
        self.assertEqual(self.call('export', '--output', str(output))['revisions'], 2)
        rows = [json.loads(line) for line in output.read_text(encoding='utf-8').splitlines()]
        self.assertEqual([row['revision'] for row in rows], [1, 2])
        before = output.read_bytes()
        self.call('export', '--output', str(output), succeeds=False)
        self.assertEqual(output.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
