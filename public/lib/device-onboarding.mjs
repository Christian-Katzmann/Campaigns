export function deviceOnboardingPresentation(capability) {
  const available = capability?.available === true;
  return {
    buttonHidden: !available,
    hint: available
      ? ''
      : capability?.hint || 'Phone onboarding is not available on this machine yet.',
    hintHidden: available,
  };
}
