export function buildJevSuiteSelectionRequest({ changedFiles = [], missions = [] } = {}) {
  const catalog = missions.map((mission, index) => ({
    id: `mission_${index + 1}`,
    file: mission.file,
    tags: mission.tags || [],
  }));
  const questions = {};
  for (const mission of catalog) {
    questions[`select_${mission.id}`] = {
      type: 'noul',
      instructions: `Should the test mission ${mission.file} be selected for this code change?`,
      criteria: {
        true: 'The changed files could affect behavior covered by this mission, directly or through shared dependencies.',
        false: 'The mission is unrelated to the changed files and can be omitted from this targeted run.',
      },
    };
  }
  return {
    state: {
      task: 'Select relevant end-to-end test missions for a targeted CI run. Prefer coverage when uncertain.',
      changedFiles,
      missions: catalog,
    },
    questions,
    catalog,
  };
}

export function interpretJevSuiteSelection(answers = {}, catalog = [], threshold = 0.7) {
  return catalog.map(mission => {
    const probability = Number(answers[`select_${mission.id}`]?.noul);
    return {
      file: mission.file,
      tags: mission.tags,
      probability,
      selected: Number.isFinite(probability) && probability >= threshold,
    };
  });
}
