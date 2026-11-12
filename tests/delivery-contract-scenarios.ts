import assert from 'node:assert/strict';
import * as delivery_acceptance_model from './delivery-acceptance-model-contract-fixture.js';
import * as delivery_check_adapter from './delivery-check-adapter-contract-fixture.js';
import * as review_evidence_model from './review-evidence-model-contract-fixture.js';
import * as skill_resource_evidence_model from './skill-resource-evidence-model-contract-fixture.js';
import * as task_evidence_model from './task-evidence-model-contract-fixture.js';
import * as source_artifact_model from './source-artifact-model-contract-fixture.js';
import * as source_artifact_adapter from './source-artifact-adapter-contract-fixture.js';
import * as conversation_source from './conversation-source-contract-fixture.js';

export type DeliveryScenario = { label: string; condition: string; operation: string; result: string; create: () => AsyncGenerator<string, void, unknown> };
export const deliveryScenarios: DeliveryScenario[] = [
  { label: "交付检查生命周期", condition: "当前检查已冻结获准历史报告", operation: "改写历史视图后由检查员依据冻结材料直接修正", result: "检查员依据冻结原文直接交付且不退回负责人", create: delivery_acceptance_model.fixesApprovedHistoricalMaterialAndVerifiesItsExactQuoteThroughRecheck },
  { label: "交付检查生命周期", condition: "已批准的历史报告已不可读取", operation: "提交候选准备独立检查", result: "将缺少的历史材料交给下游并声明缺口后交付", create: delivery_acceptance_model.settlesWithoutACheckWhenAnApprovedHistoricalReferenceCanNoLongerBeRead },
  { label: "交付检查生命周期", condition: "用户硬约束未写入解释结果", operation: "整理交付验收要求", result: "保留来自目标和输入的每项硬约束", create: delivery_acceptance_model.retainsDirectRequirementsOmittedByAValidatedInputInterpretation },
  { label: "交付检查生命周期", condition: "候选已获独立检查授权", operation: "提交全部要求通过的检查回执", result: "只发布当前候选并计一次检查", create: delivery_acceptance_model.publishesTheCandidateAfterOneIndependentAllPassRequest },
  { label: "交付检查生命周期", condition: "当前检查正在等待带尝试身份的结果", operation: "先提交无尝试身份结果再提交当前合法结果", result: "拒绝无绑定结果而当前检查仍可发布", create: delivery_acceptance_model.keepsTheCurrentCheckAliveWhenAResultHasNoAttemptIdentity },
  { label: "交付检查生命周期", condition: "检查已领取但尚未发起模型请求", operation: "结算该检查工作", result: "以CHECK_NOT_COMPLETED部分结束且检查费用为零", create: delivery_acceptance_model.settlesAClaimedCheckWithoutAModelReceiptAsIncomplete },
  { label: "交付检查生命周期", condition: "负责人未提供要求的报告文件", operation: "检查员无法补齐文件时声明该缺口", result: "声明文件缺失并正常交付且不再安排负责人", create: delivery_acceptance_model.letsAMissingArtifactConsumeTheOnlyAutomaticCorrectionOpportunity },
  { label: "交付检查生命周期", condition: "要求报告但没有检查额度", operation: "提交缺失报告的候选", result: "检查预算不足时明确结算且不安排修正", create: delivery_acceptance_model.settlesMissingArtifactsWithoutSpendingACorrectionWhenThereIsNoCheckBudget },
  { label: "交付检查生命周期", condition: "当前独立检查已获授权", operation: "提交遗漏要求的检查结果", result: "仅预约技术重试而不安排作者改写", create: delivery_acceptance_model.treatsAMissingCriterionAsACheckFailureWithoutSchedulingAuthorWork },
  { label: "交付检查生命周期", condition: "当前独立检查已获授权且有原始来源", operation: "提交引用错误来源的结论", result: "保存当前结论并依其状态结算", create: delivery_acceptance_model.treatsAQuotationAttributedToTheWrongSourceAsATechnicalFailure },
  { label: "交付检查生命周期", condition: "当前独立检查已获授权", operation: "提交无法验证的检查结论", result: "正文声明无法验证并正常交付且不退回上游", create: delivery_acceptance_model.settlesAnUnverifiedFindingWithoutAutomaticallyRewritingTheCandidate },
  { label: "交付检查生命周期", condition: "当前检查员可以自行修复已知问题", operation: "直接交付修正稿并声明仍存在的另一项问题", result: "保留当前全部结论并声明缺口正常交付", create: delivery_acceptance_model.rechecksEarlierPassingRequirementsAndSettlesANewRegressionAfterTheOnlyCorrection },
  { label: "交付检查生命周期", condition: "检查中的候选收到可信用户补充", operation: "交回补充前候选的检查通过结果", result: "保留补充并只调度包含最新输入的负责人", create: delivery_acceptance_model.preservesAnAcceptedUserSupplementBeforeReleasingTheCheckedCandidate },
  { label: "交付检查生命周期", condition: "当前检查仅余一次额度且尚未得到结论", operation: "记录当前候选的失败结论", result: "保留发现并正常交付且不安排上游修正", create: delivery_acceptance_model.retainsTheFindingWhenTheRemainingCheckBudgetCannotReserveAReview },
  { label: "交付检查生命周期", condition: "当前检查已消耗一次协议技术补试", operation: "检查员在补试工作直接交付修正稿", result: "同一检查工作补救后正常交付且仅花一次补试", create: delivery_acceptance_model.sharesOneTechnicalRetryAcrossTheFirstCheckRepairAndReview },
  { label: "交付检查生命周期", condition: "检查请求已恢复重领并消耗唯一技术重试", operation: "再次恢复已重领的检查请求", result: "恢复不补回技术重试且重复恢复不增加请求", create: delivery_acceptance_model.makesAnAuthorizedRequestSurviveRecoveryWithoutRestoringTheTechnicalRetry },
  { label: "交付检查生命周期", condition: "可信补充已中断三个经过检查的候选", operation: "再次提交新的候选", result: "不发起第四次普通检查并以预算耗尽部分结束", create: delivery_acceptance_model.spendsNoThirdOrdinaryCheckWhenTrustedSupplementsInterruptTwoCheckedCandidates },
  { label: "交付检查生命周期", condition: "无效检查结果已预约唯一技术重试", operation: "重复同一无效结果后提交有效重试结果", result: "重复结果不结算重试许可且合法重试可完成", create: delivery_acceptance_model.rejectsARepeatedInvalidCheckResultWithoutSettlingTheRetryPermit },
  { label: "交付检查生命周期", condition: "临时检查故障已预约唯一技术重试", operation: "重复同一临时故障回执", result: "拒绝重复故障且保留待执行重试和原费用", create: delivery_acceptance_model.rejectsARepeatedTransientFailureWithoutSettlingTheRetryPermit },
  { label: "交付检查生命周期", condition: "检查重试已耗尽且可信补充尚未应用", operation: "恢复任务", result: "补充仍会应用并只安排一个负责人", create: delivery_acceptance_model.appliesATrustedSupplementAfterRestartEvenWhenTheInterruptedCheckHasNoRetryLeft },
  { label: "交付检查生命周期", condition: "用户已停止正在检查的任务", operation: "交回停止前的迟到检查结果", result: "拒绝迟到结果且不发布候选", create: delivery_acceptance_model.rejectsAResultArrivingAfterTheUserStoppedTheTask },
  { label: "独立检查请求", condition: "完整固定检查材料含无关房间历史", operation: "执行一次独立检查请求", result: "只发送固定材料并原样返回逐项结论且不请求更多额度", create: delivery_check_adapter.sendsTheCompleteFixedInputInOneRequestAndReturnsOnlyTheCriterionResults },
  { label: "独立检查请求", condition: "模型回复遗漏要求", operation: "执行一次独立检查请求", result: "技术失败且不调用工具或原地修复", create: delivery_check_adapter.rejectsMissingCriterionWithoutToolOrRepair },
  { label: "独立检查请求", condition: "模型回复多出总体通过结论", operation: "执行一次独立检查请求", result: "技术失败且不调用工具或原地修复", create: delivery_check_adapter.rejectsOverallVerdictWithoutToolOrRepair },
  { label: "独立检查请求", condition: "模型回复引用回执中不存在的原话", operation: "执行一次独立检查请求", result: "原样采用下游结论且不调用额外工具", create: delivery_check_adapter.rejectsUnknownReceiptQuoteWithoutToolOrRepair },
  { label: "独立检查请求", condition: "模型回复要求执行本地工具", operation: "执行一次独立检查请求", result: "向既有授权工具入口请求补救而不越过其限制", create: delivery_check_adapter.rejectsToolActionWithoutToolOrRepair },
  { label: "独立检查请求", condition: "负面结论逐字引用指定回执", operation: "执行一次独立检查请求", result: "原样保留有依据的负面结论", create: delivery_check_adapter.preservesANegativeResultWhenItsExactQuoteIsPresentInTheNamedReceipt },
  { label: "独立检查请求", condition: "固定材料超过本地检查上下文容量", operation: "执行一次独立检查请求", result: "返回永久CHECK_CONTEXT_LIMIT且不发送传输", create: delivery_check_adapter.returnsAnExplicitPermanentCapacityErrorWithoutSendingOversizedMaterial },
  { label: "独立检查请求", condition: "提供方返回上下文容量拒绝并夹带私有提示", operation: "执行一次独立检查请求", result: "返回永久CHECK_CONTEXT_LIMIT且不保存私有回显", create: delivery_check_adapter.mapsAProviderCapacityRejectionToAnUncheckedScopeWithoutStoringItsMessage },
  { label: "独立检查请求", condition: "OpenRouter配置启用了检索压缩截断和备用提供方", operation: "执行一次独立检查请求", result: "保留提供方顺序并禁用检索压缩截断和回退", create: delivery_check_adapter.disablesProviderSideRetrievalContextCompressionAndFallbacksForAnOpenRouterCheck },
  { label: "协作审查证据", condition: "协作者已消费完整审查请求并回复", operation: "提交候选并重新打开任务", result: "检查材料保留完整请求回答成员和成功状态", create: review_evidence_model.freezesConsumedReviewRequestAndAnswerThroughRecovery },
  { label: "协作审查证据", condition: "候选有冻结的协作审查原话", operation: "提交逐字引用审查原话的检查结论", result: "接受引文并完成发布", create: review_evidence_model.acceptsAVerbatimCitationToTheFrozenReviewResultAtTheStateBoundary },
  { label: "协作审查证据", condition: "候选有真实协作审查但引用内容不存在", operation: "提交虚构审查引文的检查结论", result: "采用当前检查结论且不额外审核引文", create: review_evidence_model.rejectsAFabricatedQuoteFromARealReviewResult },
  { label: "协作审查证据", condition: "协作审查只完成部分工作", operation: "提交候选准备独立检查", result: "审查证据仍标记部分完成", create: review_evidence_model.preservesPartialReviewStatusWithoutConvertingItToSuccess },
  { label: "协作审查证据", condition: "旧目标已完成协作审查", operation: "切换目标后提交候选", result: "新目标不包含旧目标的审查证据", create: review_evidence_model.excludesACompletedReviewForAnOldGoal },
  { label: "协作审查证据", condition: "协作请求仍在等待成员结果", operation: "尝试提交候选", result: "拒绝提交且不创建独立检查", create: review_evidence_model.excludesAPendingRequestWithoutAConsumedMemberResult },
  { label: "技能资源检查证据", condition: "技能资源读取已完整成功", operation: "生成交付检查证据", result: "保留真实全文和资源版本哈希成员及字节数", create: skill_resource_evidence_model.givesTheCheckTheActualCompleteResourceAndItsProvenance },
  { label: "技能资源检查证据", condition: "技能资源读取只取得分页", operation: "生成交付检查证据", result: "不将分页声明为完整正文且冻结哈希为空", create: skill_resource_evidence_model.keepsPagedResourceIncomplete },
  { label: "技能资源检查证据", condition: "技能资源读取失败", operation: "生成交付检查证据", result: "不将失败声明为完整正文且冻结哈希为空", create: skill_resource_evidence_model.keepsFailedResourceIncomplete },
  { label: "技能资源检查证据", condition: "候选已冻结技能资源正文", operation: "随后修改保存的资源正文再生成证据", result: "拒绝变化后的冻结证据", create: skill_resource_evidence_model.rejectsChangedContentAfterTheCandidateFixedItsEvidence },
  { label: "技能资源检查证据", condition: "技能资源读取属于旧目标", operation: "生成当前交付检查证据", result: "不包含旧目标资源", create: skill_resource_evidence_model.excludesReadingFromAnOlderGoal },
  { label: "技能资源检查证据", condition: "旧技能资源引用缺少冻结快照", operation: "使用该引用生成交付检查证据", result: "拒绝没有快照的旧资源引用", create: skill_resource_evidence_model.rejectsALegacyResourceReferenceWithoutItsFrozenReceiptSnapshot },
  { label: "技能资源检查证据", condition: "候选已冻结技能资源哈希", operation: "随后修改回执哈希再生成证据", result: "拒绝变化后的冻结证据", create: skill_resource_evidence_model.rejectsChangedFrozenHash },
  { label: "技能资源检查证据", condition: "候选已冻结技能版本", operation: "随后修改技能版本再生成证据", result: "拒绝变化后的冻结证据", create: skill_resource_evidence_model.rejectsChangedFrozenSkillVersion },
  { label: "技能资源检查证据", condition: "候选已冻结资源读取位置", operation: "随后修改下一分页位置再生成证据", result: "拒绝变化后的冻结证据", create: skill_resource_evidence_model.rejectsChangedFrozenNextOffset },
  { label: "本地回执证据", condition: "当前候选有完整本地回执", operation: "投影固定检查证据并尝试分页读取", result: "检查收到原文及来源且分页读取被拒绝并不扣额外费用", create: task_evidence_model.givesTheCheckerOneFixedSourceWithItsOriginalTextAndDeniesPagedReads },
  { label: "本地回执证据", condition: "当前候选的本地回执已截断", operation: "投影固定检查证据", result: "只保留截断元数据且不提供可引用正文", create: task_evidence_model.keepsATruncatedCheckSourceAsMetadataWithoutPresentingAUsableQuotation },
  { label: "本地回执证据", condition: "已有一次成功CLI回执", operation: "使用相同行为和哈希请求新CLI操作", result: "保留旧成功回执并建立独立的新排队操作", create: task_evidence_model.retainsADistinctCLIOperationEvenWhenItsActionAndHashMatchTheOriginal },
  { label: "本地回执证据", condition: "本地回执正文已截断", operation: "列出可用证据", result: "完整性为truncated且不虚构完整字符数", create: task_evidence_model.projectsTruncatedReceipt },
  { label: "本地回执证据", condition: "本地回执执行失败", operation: "列出可用证据", result: "完整性为failed且不虚构完整字符数", create: task_evidence_model.projectsFailedReceipt },
  { label: "本地回执证据", condition: "本地回执未保存正文", operation: "列出可用证据", result: "完整性为missing且不虚构完整字符数", create: task_evidence_model.projectsMissingReceipt },
  { label: "本地回执证据", condition: "旧本地回执缺少完整性证明", operation: "列出可用证据", result: "完整性为unknown且不虚构完整字符数", create: task_evidence_model.projectsUnknownReceipt },
  { label: "本地回执证据", condition: "来源ID属于其他任务", operation: "请求读取来源正文", result: "拒绝EVIDENCE_UNAVAILABLE且不增加费用", create: task_evidence_model.refusesSourceIDsOutsideTheTask },
  { label: "本地回执证据", condition: "来源回执属于旧目标", operation: "在新目标中请求来源正文", result: "拒绝来源且当前证据目录为空", create: task_evidence_model.refusesAPriorGoalReceiptFromTheNewActiveWork },
  { label: "本地回执证据", condition: "协作者任务没有分配已有来源", operation: "请求读取该来源正文", result: "拒绝来源且不增加费用", create: task_evidence_model.refusesAnExistingSourceAbsentFromTheAssignment },
  { label: "本地回执证据", condition: "主持人已在当前协作任务选定来源", operation: "领取已获分配来源的读取工作", result: "只保留已知获分配来源引用", create: task_evidence_model.admitsAHostSelectedSourceInTheCurrentAssignment },
  { label: "本地回执证据", condition: "分页读取已排队但尚未开始", operation: "停止任务", result: "取消排队读取且不扣读取费用", create: task_evidence_model.cancelsAQueuedReadWithoutConsumingItsBudget },
  { label: "本地回执证据", condition: "普通请求额度已耗尽", operation: "首次请求分页读取", result: "拒绝读取且费用保持原值", create: task_evidence_model.refusesAFirstReadWhenOrdinaryBudgetIsExhausted },
  { label: "本地回执证据", condition: "分页读取已成功并结算", operation: "恢复任务", result: "保留相同正文回执和已有费用", create: task_evidence_model.preservesTheCompletedReadAndItsChargeOnRecovery },
  { label: "本地回执证据", condition: "分页读取已恢复并确认未开始且可重新领取", operation: "以原操作身份重新领取分页读取", result: "以相同操作身份增加尝试且不重复扣费", create: task_evidence_model.reclaimsARecoveredInProgressReadUnderTheSameIdentityWithoutChargingAgain },
  { label: "本地回执证据", condition: "同目标的来源来自上一执行世代", operation: "在当前世代列出来源证据", result: "仅作为历史观察并保留原世代和时间", create: task_evidence_model.exposesASettledSourceFromAPreviousEpochOnlyAsHistoricalObservation },
  { label: "固定原文修订", condition: "新修订任务已固定旧报告且历史中也有旧报告", operation: "从外部修改提交时的原文对象", result: "任务保留分离原文并不将其列入历史或当前产物", create: source_artifact_model.preservesADetachedSourceAndKeepsItOutsideHistoryAndCurrentArtifacts },
  { label: "固定原文修订", condition: "输入解释工作已取得固定原文", operation: "提交省略来源引用的解释结果", result: "主持人保留原文引用并传给负责人", create: source_artifact_model.fixesTheSameSourceForModelInterpretationEvenWhenItsResultOmitsTheReference },
  { label: "固定原文修订", condition: "协作者已取得完整原文且历史随后消失", operation: "负责人提交新修订", result: "独立检查保留固定原文而当前候选只含新文档", create: source_artifact_model.sendsTheCompleteSourceToHelpersAndTheFixedIndependentCheckAfterHistoryDisappears },
  { label: "固定原文修订", condition: "修订任务需要新Markdown报告", operation: "仅提交长结论", result: "正文声明缺少修订文档并正常交付且不伪造文件", create: source_artifact_model.deliversConclusionWithMissingRevisionDeclared },
  { label: "固定原文修订", condition: "修订任务固定了跨任务旧报告ID", operation: "把旧ID直接列为候选", result: "声明缺失文件并正常交付且不发布旧任务文件", create: source_artifact_model.deliversWithoutPublishingSourceIdentity },
  { label: "固定原文修订", condition: "修订任务固定了跨任务旧报告ID", operation: "把旧ID列入背景报告", result: "以INVALID_BACKGROUND_ARTIFACT拒绝成功发布且不创建检查", create: source_artifact_model.rejectsSourceIdentityAsBackground },
  { label: "固定原文修订", condition: "修订任务固定了跨任务旧报告ID", operation: "把旧ID用作当前修订基底", result: "以INVALID_ARTIFACT_REVISION_BASE拒绝成功发布且不创建检查", create: source_artifact_model.rejectsSourceIdentityAsRevisionBase },
  { label: "固定原文修订", condition: "修订任务需要新Markdown报告", operation: "提交非Markdown报告", result: "声明缺少Markdown修订并正常交付现有文件", create: source_artifact_model.deliversNonMarkdownRevisionWithGapDeclared },
  { label: "固定原文修订", condition: "修订任务需要新Markdown报告", operation: "提交空白Markdown报告", result: "以INVALID_REPORT拒绝成功发布且不创建检查", create: source_artifact_model.rejectsEmptyMarkdownRevision },
  { label: "固定原文修订", condition: "旧来源身份不属于当前任务产物", operation: "发送带旧来源ID的产物事件", result: "拒绝身份注入且当前产物仍为空", create: source_artifact_model.cannotInjectTheOldSourceIdentityThroughTheArtifactEvent },
  { label: "固定原文修订", condition: "负责人已提交保留原文的新修订文档", operation: "独立检查当前候选并全部通过", result: "只发布新文档且固定来源保持原样", create: source_artifact_model.publishesOnlyTheNewDocumentAfterAnIndependentCurrentCandidateCheck },
  { label: "固定原文修订", condition: "候选未保留必须保存的原文要求", operation: "独立检查报告保留要求失败", result: "正文保留失败发现并正常交付且不退回负责人", create: source_artifact_model.deliversPreservationFailureWithoutReturningToOwner },
  { label: "固定原文修订", condition: "原文已固定且用户已停止任务", operation: "提交停止前的迟到交付并保存恢复任务", result: "拒绝迟到交付且恢复后保留原文并只提供宿主停止报告", create: source_artifact_model.preservesTheFixedSourceOnStopStaleCompletionAndPersistedRecovery },
  { label: "固定原文修订", condition: "旧任务快照没有固定来源", operation: "按原协议提交候选", result: "继续按原有检查流程处理", create: source_artifact_model.retainsExistingBehaviorForSnapshotsWithNoSource },
  { label: "固定原文模型请求", condition: "负责人工作有完整固定原文", operation: "构造并执行修订模型请求", result: "完整传递原文并给出隔离和默认文件名规则", create: source_artifact_adapter.sendsTheOriginalCompleteTextAndSourceIsolationInstructions },
  { label: "固定原文模型请求", condition: "负责人原文超出上下文容量", operation: "尝试执行修订模型请求", result: "返回永久SOURCE_CONTEXT_LIMIT且不发传输", create: source_artifact_adapter.rejectsOversizedOwnerSourceBeforeTransport },
  { label: "固定原文模型请求", condition: "协作者原文超出上下文容量", operation: "尝试执行修订模型请求", result: "返回永久SOURCE_CONTEXT_LIMIT且不发传输", create: source_artifact_adapter.rejectsOversizedAssistanceSourceBeforeTransport },
  { label: "固定原文模型请求", condition: "解释工作原文超出上下文容量", operation: "尝试执行修订模型请求", result: "返回永久SOURCE_CONTEXT_LIMIT且不发传输", create: source_artifact_adapter.rejectsOversizedInterpretationSourceBeforeTransport },
  { label: "固定原文模型请求", condition: "提供方容量拒绝含私有原文回显", operation: "执行修订模型请求", result: "返回SOURCE_CONTEXT_LIMIT且不回显提供方私有正文", create: source_artifact_adapter.reportsProviderContextRejectionWithoutEchoingItsPrivateResponse },
  { label: "固定原文模型请求", condition: "原文工作配置自动截断压缩检索回退", operation: "执行修订模型请求", result: "禁用全部改变固定原文的提供方机制", create: source_artifact_adapter.preventsAutomaticTruncationCompressionRetrievalAndFallbackForFixedSourceWork },
  { label: "固定原文历史", condition: "旧报告正文位于结果详情且已作为固定来源", operation: "整理新任务历史", result: "保留原消息摘要和引用且不重复历史原文或修改旧任务", create: conversation_source.passesALegacyLongAnswerOnceThroughTheFixedSourceWhileRetainingTheOriginalMessage },
  { label: "固定原文历史", condition: "旧报告全文就是结果消息正文且已作为固定来源", operation: "整理新任务历史", result: "仅新历史使用来源数据说明并保留旧消息原文", create: conversation_source.replacesALegacyFullTextMessageWithADataNoteOnlyInTheNewHistory },
];
export async function runDeliveryContractGate() {
  for (const scenario of deliveryScenarios) {
    const run = scenario.create();
    assert.equal((await run.next()).value, 'prepared');
    assert.equal((await run.next()).value, 'observed');
    assert.equal((await run.next()).done, true);
  }
  return { scenarios: deliveryScenarios.length };
}
