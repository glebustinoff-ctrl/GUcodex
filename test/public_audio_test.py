import unittest
from scripts.public_audio import rank_candidate


class CandidateTests(unittest.TestCase):
    def item(self, **extra):
        return {'title': 'Кино — Кукушка (Official Audio)', 'uploader': 'Кино', 'duration': 240, **extra}

    def test_cyrillic_title_and_official_channel(self):
        self.assertGreaterEqual(rank_candidate(self.item(), 'Кукушка', 'Кино'), 0)
        self.assertGreaterEqual(rank_candidate({'title': 'Ёлка', 'uploader': 'Автор - Topic', 'duration': 100}, 'Елка', 'Автор'), 0)

    def test_wrong_artist_and_wrong_song(self):
        self.assertEqual(rank_candidate(self.item(title='Кукушка', uploader='Другой автор'), 'Кукушка', 'Кино'), -1)
        self.assertEqual(rank_candidate(self.item(title='Кино — Группа крови'), 'Кукушка', 'Кино'), -1)

    def test_rejects_unrequested_covers_and_versions(self):
        for version in ['Cover', 'Karaoke', 'кавер', 'минус', 'Live', 'slowed']:
            with self.subTest(version=version):
                self.assertEqual(rank_candidate(self.item(title='Кино — Кукушка '+version), 'Кукушка', 'Кино'), -1)
        self.assertGreaterEqual(rank_candidate(self.item(title='Кино — Кукушка Live'), 'Кукушка Live', 'Кино'), 0)

    def test_live_private_and_preview_rejected(self):
        for extra in [{'is_live': True}, {'live_status': 'is_upcoming'}, {'availability': 'private'}, {'availability': 'needs_auth'}, {'duration': 30}, {'duration': 1500}]:
            with self.subTest(extra=extra):
                self.assertEqual(rank_candidate(self.item(**extra), 'Кукушка', 'Кино'), -1)

    def test_official_audio_preferred(self):
        plain = self.item(title='Кино — Кукушка', uploader='Слушатель')
        self.assertGreater(rank_candidate(self.item(), 'Кукушка', 'Кино'), rank_candidate(plain, 'Кукушка', 'Кино'))


if __name__ == '__main__':
    unittest.main()
