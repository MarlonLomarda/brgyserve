// Canonical vocabularies for the Blotter (dispute records) module.
// nature_of_case is varchar(20) in the schema — a short fixed classification,
// not free text. Party roles are fixed too: a dispute is meaningful only with
// at least one complainant and one respondent (enforced in the route).

const NATURE_OF_CASE = {
  CRIMINAL: 'Criminal',
  CIVIL: 'Civil',
  OTHERS: 'Others',
};
const NATURES = Object.values(NATURE_OF_CASE);

const PARTY_ROLE = {
  COMPLAINANT: 'Complainant',
  RESPONDENT: 'Respondent',
};
const PARTY_ROLES = Object.values(PARTY_ROLE);

module.exports = { NATURE_OF_CASE, NATURES, PARTY_ROLE, PARTY_ROLES };
