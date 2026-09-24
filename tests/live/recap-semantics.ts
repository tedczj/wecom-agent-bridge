import type { RecapContent } from '../../src/answers/recap.ts';

/** Conservative fixture rubric. Actual execution and Git facts are checked separately. */
export function recapSemanticFacts(content: RecapContent, visible: string) {
  const restriction = (words: string) => new RegExp('(?:不|未|没有|禁止|不得)[^\\n。；]{0,60}(?:' + words + ')', 'i').test(visible);
  const labels = content.options.map(option => option.label.trim().replace(/^方案\s*/, ''));
  return { noCodeChanges: restriction('修改|改动|编辑'), noCommit: restriction('提交|commit'), noPush: restriction('推送|push'),
    pending: content.pending.some(value => value.trim().length > 0), options: JSON.stringify(labels) === JSON.stringify(['A', 'B']),
    question: content.questions.some(value => value.trim().length > 0),
    testReported: /测试|test/i.test(content.completed.join('\n')),
    noClaimedImplementation: !content.completed.some(value => /(?:已|已经|完成了)[^。；\n]{0,16}(?:修改|改动|部署|上线|提交|推送|实现)/.test(value)) };
}
