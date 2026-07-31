import { normalizeModifierGroupsForResolution } from "./response-contract.js";

const MAX_CANDIDATE_GROUPS = 25;
const MAX_CANDIDATE_OPTIONS = 100;
const MAX_CANDIDATE_PATHS_PER_ISSUE = 8;
const MAX_CANDIDATE_PATHS_TOTAL = 32;
const MAX_OPTION_QUANTITY = 100;

function normalizedText(value) {
  return String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function stringValue(...values) {
  const value = values.find(
    (entry) => typeof entry === "string" || typeof entry === "number"
  );
  if (value === undefined) {
    return undefined;
  }
  return String(value).trim() || undefined;
}

function optionId(value) {
  return stringValue(value?.option_id, value?.optionId, value?.id);
}

function optionName(value) {
  return typeof value === "string"
    ? value
    : stringValue(value?.name, value?.option_name, value?.optionName);
}

function requestedQuantity(value) {
  const raw = value && typeof value === "object" ? value.quantity : undefined;
  if (raw === undefined) {
    return { value: 1 };
  }
  const quantity = Number(raw);
  return (
    Number.isInteger(quantity) &&
    quantity > 0 &&
    quantity <= MAX_OPTION_QUANTITY
  )
    ? { value: quantity }
    : {
        error: `quantity must be an integer from 1 to ${MAX_OPTION_QUANTITY}`
      };
}

function groupMinimum(group) {
  return Number.isFinite(group.min_selections) && group.min_selections > 0
    ? group.min_selections
    : group.required === true
      ? 1
      : 0;
}

function groupMaximum(group) {
  return Number.isFinite(group.max_selections) && group.max_selections > 0
    ? group.max_selections
    : Infinity;
}

function availableOptions(group) {
  return (group.options || []).filter((option) => option.available !== false);
}

function pathIsAvailable(path) {
  return path.every(({ option }) => option.available !== false);
}

function exactMatchKind(group, option, requestName) {
  const requested = normalizedText(requestName);
  const choice = normalizedText(option.name);
  const groupName = normalizedText(group.name);
  if (!requested || !choice) {
    return undefined;
  }
  if (requested === choice) {
    return "option";
  }
  if (requested === `${groupName} ${choice}`) {
    return "qualified";
  }
  const choiceTokens = new Set(choice.split(/\s+/));
  if (requested === groupName && choiceTokens.has("yes")) {
    return "qualified";
  }
  if (
    (requested === `no ${groupName}` || requested === `${groupName} no`) &&
    choiceTokens.has("no")
  ) {
    return "qualified";
  }
  return undefined;
}

function relatedNameMatch(group, option, requestName) {
  const requested = normalizedText(requestName);
  if (!requested || requested.length < 4) {
    return false;
  }
  const optionText = ` ${normalizedText(option.name)} `;
  const qualifiedText = ` ${normalizedText(`${group.name || ""} ${option.name || ""}`)} `;
  const phrase = ` ${requested} `;
  return optionText.includes(phrase) || qualifiedText.includes(phrase);
}

function createIndex(groups) {
  const occurrences = [];
  const byId = new Map();
  const occurrenceIds = new WeakMap();
  let nextOccurrenceId = 1;

  function visit(currentGroups, parentPath = []) {
    for (const group of currentGroups || []) {
      for (const option of group.options || []) {
        const path = [...parentPath, { group, option }];
        const occurrence = {
          group,
          option,
          path,
          depth: path.length,
          key: nextOccurrenceId
        };
        nextOccurrenceId += 1;
        occurrenceIds.set(option, occurrence.key);
        occurrences.push(occurrence);
        const matches = byId.get(option.option_id) || [];
        matches.push(occurrence);
        byId.set(option.option_id, matches);
        visit(option.modifier_groups, path);
      }
    }
  }

  visit(groups);
  return { occurrences, byId, occurrenceIds };
}

function createState(index) {
  return {
    index,
    selected: new Map(),
    problems: [],
    problemSet: new Set(),
    candidatePaths: [],
    candidatePathKeys: new Set(),
    omittedCandidatePaths: 0
  };
}

function addProblem(state, message) {
  if (!state.problemSet.has(message)) {
    state.problemSet.add(message);
    state.problems.push(message);
  }
}

function selectedForGroup(state, group) {
  let selected = state.selected.get(group);
  if (!selected) {
    selected = new Map();
    state.selected.set(group, selected);
  }
  return selected;
}

function selectedUnits(state, group) {
  return [...selectedForGroup(state, group).values()].reduce(
    (total, selection) => total + selection.quantity,
    0
  );
}

function pathKey(state, path) {
  return path
    .map(({ option }) => state.index.occurrenceIds.get(option))
    .join("/");
}

function addCandidatePaths(state, paths) {
  const limited = paths.slice(0, MAX_CANDIDATE_PATHS_PER_ISSUE);
  state.omittedCandidatePaths += Math.max(0, paths.length - limited.length);
  for (const path of limited) {
    const key = pathKey(state, path);
    if (state.candidatePathKeys.has(key)) {
      continue;
    }
    if (state.candidatePaths.length >= MAX_CANDIDATE_PATHS_TOTAL) {
      state.omittedCandidatePaths += 1;
      continue;
    }
    state.candidatePathKeys.add(key);
    state.candidatePaths.push(path);
  }
}

function setSelection(
  state,
  group,
  option,
  quantity,
  { terminalSource, ancestor = false } = {}
) {
  const selected = selectedForGroup(state, group);
  const existing = selected.get(option);
  if (existing) {
    if (terminalSource && existing.terminalSource && existing.terminalSource !== terminalSource) {
      addProblem(
        state,
        `Option "${option.name || option.option_id}" was requested more than once. Use one entry with the intended quantity.`
      );
      return false;
    }
    if (terminalSource) {
      existing.terminalSource = terminalSource;
      existing.quantity = quantity;
    } else if (!ancestor) {
      existing.quantity = quantity;
    }
    return true;
  }
  selected.set(option, {
    option,
    quantity,
    terminalSource
  });
  return true;
}

function pathCompatibility(state, path, terminalQuantity) {
  const projectedUnits = new Map();
  for (const [index, { group, option }] of path.entries()) {
    if (option.available === false) {
      return { compatible: false, reason: "unavailable" };
    }
    const selected = selectedForGroup(state, group);
    const existing = selected.get(option);
    const current = projectedUnits.has(group)
      ? projectedUnits.get(group)
      : selectedUnits(state, group);
    const desired =
      index === path.length - 1
        ? terminalQuantity
        : existing?.quantity || 1;
    const next = current - (existing?.quantity || 0) + desired;
    if (next > groupMaximum(group)) {
      return { compatible: false, reason: "maximum", group };
    }
    projectedUnits.set(group, next);
  }
  return { compatible: true };
}

function applyPath(state, path, quantity, source) {
  const compatibility = pathCompatibility(state, path, quantity);
  if (!compatibility.compatible) {
    return compatibility;
  }
  for (const [index, { group, option }] of path.entries()) {
    const terminal = index === path.length - 1;
    setSelection(
      state,
      group,
      option,
      terminal ? quantity : 1,
      terminal
        ? { terminalSource: source }
        : { ancestor: true }
    );
  }
  return { compatible: true };
}

function activeGroupEntries(groups, state, parentPath = [], entries = []) {
  for (const group of groups || []) {
    entries.push({ group, parentPath });
    const selected = state.selected.get(group);
    if (!selected) {
      continue;
    }
    for (const { option } of selected.values()) {
      activeGroupEntries(
        option.modifier_groups,
        state,
        [...parentPath, { group, option }],
        entries
      );
    }
  }
  return entries;
}

function activeOccurrences(groups, state) {
  return activeGroupEntries(groups, state).flatMap(({ group, parentPath }) =>
    (group.options || []).map((option) => ({
      group,
      option,
      path: [...parentPath, { group, option }],
      depth: parentPath.length + 1
    }))
  );
}

function normalizeRequests(values, state) {
  return (values || []).map((value, index) => {
    const name = optionName(value);
    const quantity = requestedQuantity(value);
    const request = {
      index,
      name,
      option_id: optionId(value),
      quantity: quantity.value,
      source: `requested:${index}`,
      resolved: false,
      invalid: false
    };
    if (!name) {
      addProblem(state, `requested_options entry ${index + 1} is missing name.`);
      request.invalid = true;
    }
    if (quantity.error) {
      addProblem(
        state,
        `requested_options entry "${name || index + 1}" ${quantity.error}.`
      );
      request.invalid = true;
    }
    return request;
  });
}

function seedNestedSelections(groups, values, state, parentPath = []) {
  const seen = new Set();
  for (const [index, value] of (values || []).entries()) {
    const id = optionId(value);
    const quantity = requestedQuantity(value);
    if (!id) {
      addProblem(state, "Selected option is missing option_id.");
      continue;
    }
    if (quantity.error) {
      addProblem(state, `Selected option ${id} ${quantity.error}.`);
      continue;
    }
    const matches = (groups || []).flatMap((group) =>
      (group.options || [])
        .filter((option) => option.option_id === id)
        .map((option) => ({
          group,
          option,
          path: [...parentPath, { group, option }]
        }))
    );
    const available = matches.filter(({ option }) => option.available !== false);
    if (!available.length) {
      addProblem(
        state,
        matches.length
          ? `Selected option ${id} is currently unavailable.`
          : `Selected option ${id} is not available under its supplied parent path.`
      );
      addCandidatePaths(state, matches.map(({ path }) => path));
      continue;
    }
    if (available.length !== 1) {
      addProblem(
        state,
        `Selected option ${id} is ambiguous at its supplied parent path.`
      );
      addCandidatePaths(state, available.map(({ path }) => path));
      continue;
    }
    const [{ group, option, path }] = available;
    const suppliedName = optionName(value);
    if (
      suppliedName &&
      normalizedText(suppliedName) !== normalizedText(option.name)
    ) {
      addProblem(
        state,
        `Selected option ${id} is named "${option.name}"; the supplied name "${suppliedName}" does not match.`
      );
      addCandidatePaths(state, [path]);
      continue;
    }
    const occurrenceKey = state.index.occurrenceIds.get(option);
    if (seen.has(occurrenceKey)) {
      addProblem(
        state,
        `Selected option ${id} was supplied more than once at the same parent path.`
      );
      continue;
    }
    seen.add(occurrenceKey);
    const result = applyPath(
      state,
      path,
      quantity.value,
      `nested:${parentPath.length}:${index}`
    );
    if (!result.compatible) {
      addProblem(
        state,
        `Selected option ${id} exceeds the maximum selections for ${result.group?.name || group.name}.`
      );
      addCandidatePaths(state, [path]);
      continue;
    }
    seedNestedSelections(
      option.modifier_groups,
      value?.options,
      state,
      path
    );
  }
}

function nameCandidatesFromOccurrences(occurrences, state, request) {
  const availableOccurrences = occurrences.filter(({ path }) =>
    pathIsAvailable(path)
  );
  const exact = availableOccurrences.filter(({ group, option }) =>
    exactMatchKind(group, option, request.name)
  );
  const hasQualifiedExact = exact.some(
    ({ group, option }) =>
      exactMatchKind(group, option, request.name) === "qualified"
  );
  const related = hasQualifiedExact
    ? exact
    : availableOccurrences.filter(({ group, option }) =>
        relatedNameMatch(group, option, request.name)
      );
  const compatibleExact = exact.filter(({ path }) =>
    pathCompatibility(state, path, request.quantity).compatible
  );
  const compatibleRelated = related.filter(({ path }) =>
    pathCompatibility(state, path, request.quantity).compatible
  );
  return {
    exact,
    related,
    compatibleExact,
    compatibleRelated
  };
}

function requestNameCandidates(groups, state, request) {
  return nameCandidatesFromOccurrences(
    activeOccurrences(groups, state),
    state,
    request
  );
}

function globalNameCandidates(state, request) {
  return nameCandidatesFromOccurrences(
    state.index.occurrences,
    state,
    request
  );
}

function resolvableNameRequest(groups, state, request) {
  const candidates = requestNameCandidates(groups, state, request);
  if (
    candidates.compatibleExact.length === 1 &&
    candidates.compatibleRelated.length === 1
  ) {
    return candidates.compatibleExact[0];
  }
  return undefined;
}

function requestIdCandidates(state, request) {
  const all = state.index.byId.get(request.option_id) || [];
  const named = all.filter(
    ({ group, option }) => {
      const requested = normalizedText(request.name);
      return (
        requested === normalizedText(option.name) ||
        requested === normalizedText(`${group.name || ""} ${option.name || ""}`)
      );
    }
  );
  const available = named.filter(({ path }) => pathIsAvailable(path));
  const compatible = available.filter(({ path }) =>
    pathCompatibility(state, path, request.quantity).compatible
  );
  return { all, named, available, compatible };
}

function qualifiedCandidateNames(candidates) {
  const values = candidates.map(({ group, option }) =>
    `${group.name || group.group_id || "Modifier"} ${option.name || option.option_id}`.trim()
  );
  const counts = new Map();
  for (const value of values) {
    const key = normalizedText(value);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [
    ...new Set(
      values.filter((value) => counts.get(normalizedText(value)) === 1)
    )
  ].slice(0, MAX_CANDIDATE_PATHS_PER_ISSUE);
}

function qualifiedRecovery(candidates, optionId) {
  const names = qualifiedCandidateNames(candidates);
  if (!names.length) {
    return undefined;
  }
  const choices = names.map((name) => `"${name}"`).join(" or ");
  return `Retry with the same option_id${optionId ? ` ${optionId}` : ""} and one exact qualified name: ${choices}.`;
}

function pendingSelectableSources(state, requests) {
  const sourcesByOccurrence = new Map();
  const add = (occurrence, source) => {
    for (const { option } of occurrence.path) {
      const key = state.index.occurrenceIds.get(option);
      const sources = sourcesByOccurrence.get(key) || new Set();
      sources.add(source);
      sourcesByOccurrence.set(key, sources);
    }
  };

  for (const request of requests.filter(
    (entry) => !entry.resolved && !entry.invalid
  )) {
    if (request.option_id) {
      for (const occurrence of requestIdCandidates(state, request).compatible) {
        add(occurrence, request.source);
      }
      continue;
    }
    for (const occurrence of globalNameCandidates(state, request)
      .compatibleExact) {
      add(occurrence, request.source);
    }
  }
  return sourcesByOccurrence;
}

function couldActivateAnotherNameCandidate(
  groups,
  state,
  request,
  sourcesByOccurrence
) {
  const activeGroups = currentActiveGroups(groups, state);
  const candidates = globalNameCandidates(state, request);
  const compatible = candidates.compatibleRelated.length
    ? candidates.compatibleRelated
    : candidates.compatibleExact;

  for (const occurrence of compatible) {
    if (activeGroups.has(occurrence.group)) {
      continue;
    }
    const parent = occurrence.path.at(-2);
    const key = state.index.occurrenceIds.get(parent?.option);
    const sources = sourcesByOccurrence.get(key);
    if (
      sources &&
      (sources.size > 1 || !sources.has(request.source))
    ) {
      return true;
    }
  }
  return false;
}

function resolveOneNameRequest(groups, state, requests) {
  const sourcesByOccurrence = pendingSelectableSources(state, requests);
  const choices = requests
    .filter(
      (request) =>
        !request.resolved && !request.invalid && !request.option_id
    )
    .map((request) => ({
      request,
      occurrence: resolvableNameRequest(groups, state, request)
    }))
    .filter(({ occurrence }) => occurrence)
    .filter(
      ({ request }) =>
        !couldActivateAnotherNameCandidate(
          groups,
          state,
          request,
          sourcesByOccurrence
        )
    )
    .sort(
      (left, right) =>
        left.occurrence.depth - right.occurrence.depth ||
        left.request.index - right.request.index
    );
  if (!choices.length) {
    return false;
  }
  const { request, occurrence } = choices[0];
  applyPath(
    state,
    occurrence.path,
    request.quantity,
    request.source
  );
  request.resolved = true;
  return true;
}

function currentActiveGroups(groups, state) {
  return new Set(activeGroupEntries(groups, state).map(({ group }) => group));
}

function resolveOneIdRequest(groups, state, requests) {
  const activeGroups = currentActiveGroups(groups, state);
  for (const request of requests.filter(
    (entry) =>
      !entry.resolved && !entry.invalid && Boolean(entry.option_id)
  )) {
    const candidates = requestIdCandidates(state, request);
    const active = candidates.compatible.filter(({ group }) =>
      activeGroups.has(group)
    );
    const selectable = active.length ? active : candidates.compatible;
    if (selectable.length !== 1) {
      continue;
    }
    applyPath(
      state,
      selectable[0].path,
      request.quantity,
      request.source
    );
    request.resolved = true;
    return true;
  }
  return false;
}

function autoSelectDeterministicRequired(groups, state) {
  let changed = false;
  for (const { group, parentPath } of activeGroupEntries(groups, state)) {
    const minimum = groupMinimum(group);
    const selected = selectedForGroup(state, group);
    const options = availableOptions(group);
    if (
      minimum > 0 &&
      selectedUnits(state, group) < minimum &&
      options.length === minimum
    ) {
      for (const option of options) {
        if (!selected.has(option)) {
          setSelection(state, group, option, 1, { ancestor: true });
          changed = true;
        }
      }
    }
    if (selectedUnits(state, group) > groupMaximum(group)) {
      addCandidatePaths(
        state,
        [...selected.values()].map(({ option }) => [
          ...parentPath,
          { group, option }
        ])
      );
    }
  }
  return changed;
}

function resolveRequests(groups, state, requests) {
  let progressed = true;
  while (progressed) {
    progressed = false;
    if (autoSelectDeterministicRequired(groups, state)) {
      progressed = true;
    }
    if (resolveOneNameRequest(groups, state, requests)) {
      progressed = true;
      continue;
    }
    if (resolveOneIdRequest(groups, state, requests)) {
      progressed = true;
    }
  }
}

function finalizeNameRequest(groups, state, request) {
  const active = requestNameCandidates(groups, state, request);
  const label = request.name || "requested option";
  const activeCandidates = active.compatibleRelated.length
    ? active.compatibleRelated
    : active.compatibleExact;
  if (activeCandidates.length > 1) {
    const candidateIds = activeCandidates.map(
      ({ option }) => option.option_id
    );
    const repeatedIds = new Set(candidateIds).size < candidateIds.length;
    const recovery = repeatedIds
      ? qualifiedRecovery(activeCandidates)
      : undefined;
    addProblem(
      state,
      `Requested option "${label}" is ambiguous on the selected item path. ${recovery || "Choose one returned option_id."}`
    );
    addCandidatePaths(state, activeCandidates.map(({ path }) => path));
    return;
  }
  if (activeCandidates.length === 1 && active.compatibleExact.length === 0) {
    addProblem(
      state,
      `Requested option "${label}" does not exactly match the available choice. Copy its returned name and option_id.`
    );
    addCandidatePaths(state, activeCandidates.map(({ path }) => path));
    return;
  }
  if (active.exact.length || active.related.length) {
    const conflicts = active.related.length ? active.related : active.exact;
    addProblem(
      state,
      `Requested option "${label}" conflicts with the selected path or modifier quantity limit.`
    );
    addCandidatePaths(state, conflicts.map(({ path }) => path));
    return;
  }

  const allRelated = state.index.occurrences.filter(
    ({ group, option, path }) =>
      pathIsAvailable(path) &&
      (exactMatchKind(group, option, request.name) ||
        relatedNameMatch(group, option, request.name))
  );
  if (allRelated.length) {
    addProblem(
      state,
      `Requested option "${label}" exists only under an unselected parent choice. Choose a returned option_id or select its parent branch first.`
    );
    addCandidatePaths(state, allRelated.map(({ path }) => path));
    return;
  }
  addProblem(
    state,
    `Requested option "${label}" does not exactly match a current available option.`
  );
}

function finalizeIdRequest(state, request) {
  const candidates = requestIdCandidates(state, request);
  if (!candidates.all.length) {
    addProblem(
      state,
      `option_id ${request.option_id} is not available for this item.`
    );
    return;
  }
  if (!candidates.named.length) {
    const names = [...new Set(candidates.all.map(({ option }) => option.name))];
    const recovery = qualifiedRecovery(candidates.all, request.option_id);
    addProblem(
      state,
      `option_id ${request.option_id} is named "${names.join('\" or \"')}"; the supplied name "${request.name}" does not match.${recovery ? ` ${recovery}` : ""}`
    );
    addCandidatePaths(state, candidates.all.map(({ path }) => path));
    return;
  }
  if (!candidates.available.length) {
    addProblem(
      state,
      `option_id ${request.option_id} is currently unavailable.`
    );
    addCandidatePaths(state, candidates.named.map(({ path }) => path));
    return;
  }
  if (!candidates.compatible.length) {
    addProblem(
      state,
      `option_id ${request.option_id} conflicts with the selected parent path or modifier quantity limit.`
    );
    addCandidatePaths(state, candidates.available.map(({ path }) => path));
    return;
  }
  const recovery = qualifiedRecovery(
    candidates.compatible,
    request.option_id
  );
  addProblem(
    state,
    `option_id ${request.option_id} identifies more than one compatible choice path. ${recovery || "Choose a candidate after selecting its parent branch."}`
  );
  addCandidatePaths(state, candidates.compatible.map(({ path }) => path));
}

function validateActiveGroups(groups, state) {
  for (const { group, parentPath } of activeGroupEntries(groups, state)) {
    const minimum = groupMinimum(group);
    const maximum = groupMaximum(group);
    const units = selectedUnits(state, group);
    if (units < minimum) {
      addProblem(
        state,
        `Select at least ${minimum} option${minimum === 1 ? "" : "s"} for ${group.name || group.group_id || "a required modifier group"}.`
      );
      addCandidatePaths(
        state,
        availableOptions(group).map((option) => [
          ...parentPath,
          { group, option }
        ])
      );
    }
    if (units > maximum) {
      addProblem(
        state,
        `Select no more than ${maximum} option${maximum === 1 ? "" : "s"} for ${group.name || group.group_id || "a modifier group"}.`
      );
      const selected = selectedForGroup(state, group);
      addCandidatePaths(
        state,
        [...selected.values()].map(({ option }) => [
          ...parentPath,
          { group, option }
        ])
      );
    }
  }
}

function buildSelections(groups, state) {
  return (groups || []).flatMap((group) => {
    const selected = state.selected.get(group);
    if (!selected) {
      return [];
    }
    return [...selected.values()].map(({ option, quantity }) => {
      const children = buildSelections(option.modifier_groups, state);
      return {
        option_id: option.option_id,
        name: option.name || option.option_id,
        quantity,
        ...(children.length ? { options: children } : {})
      };
    });
  });
}

function candidateTree(paths) {
  const roots = [];
  let groupCount = 0;
  let optionCount = 0;
  let omitted = 0;

  function existingPathCost(path) {
    let groups = roots;
    let newGroups = 0;
    let newOptions = 0;
    for (const { group, option } of path) {
      let groupNode = groups.find((node) => node.source === group);
      if (!groupNode) {
        newGroups += 1;
        groupNode = { source: group, options: [] };
      }
      let optionNode = groupNode.options.find((node) => node.source === option);
      if (!optionNode) {
        newOptions += 1;
        optionNode = { source: option, groups: [] };
      }
      groups = optionNode.groups;
    }
    return { newGroups, newOptions };
  }

  function addPath(path) {
    const cost = existingPathCost(path);
    if (
      groupCount + cost.newGroups > MAX_CANDIDATE_GROUPS ||
      optionCount + cost.newOptions > MAX_CANDIDATE_OPTIONS
    ) {
      omitted += 1;
      return;
    }
    let groups = roots;
    for (const { group, option } of path) {
      let groupNode = groups.find((node) => node.source === group);
      if (!groupNode) {
        groupNode = { source: group, options: [] };
        groups.push(groupNode);
        groupCount += 1;
      }
      let optionNode = groupNode.options.find((node) => node.source === option);
      if (!optionNode) {
        optionNode = { source: option, groups: [] };
        groupNode.options.push(optionNode);
        optionCount += 1;
      }
      groups = optionNode.groups;
    }
  }

  for (const path of paths) {
    addPath(path);
  }

  function materialize(groups) {
    return groups.map(({ source: group, options }) => ({
      group_id: group.group_id,
      name: group.name,
      min_selections: group.min_selections,
      max_selections: group.max_selections,
      options: options.map(({ source: option, groups: nested }) => ({
        option_id: option.option_id,
        name: option.name,
        available: option.available,
        ...(nested.length ? { modifier_groups: materialize(nested) } : {})
      }))
    }));
  }

  return { groups: materialize(roots), omitted };
}

export function modifierGroupsFromItemDetails(data) {
  const source =
    data && typeof data === "object" && !Array.isArray(data)
      ? data.item || data
      : data;
  return normalizeModifierGroupsForResolution(source);
}

export function resolveModifierSelections(
  groups,
  { requestedOptions = [], nestedOptions = [] } = {}
) {
  const index = createIndex(groups || []);
  const state = createState(index);
  seedNestedSelections(groups || [], nestedOptions, state);
  const requests = normalizeRequests(requestedOptions, state);
  resolveRequests(groups || [], state, requests);

  for (const request of requests.filter(
    (entry) => !entry.resolved && !entry.invalid
  )) {
    if (request.option_id) {
      finalizeIdRequest(state, request);
    } else {
      finalizeNameRequest(groups || [], state, request);
    }
  }
  validateActiveGroups(groups || [], state);

  const compact = candidateTree(state.candidatePaths);
  const omitted = state.omittedCandidatePaths + compact.omitted;
  if (omitted > 0) {
    addProblem(
      state,
      `${omitted} additional modifier candidate path${omitted === 1 ? " was" : "s were"} omitted to keep this result bounded.`
    );
  }

  return {
    selections: buildSelections(groups || [], state),
    problems: state.problems,
    modifier_groups: compact.groups
  };
}
