// These aliases/parameters are internal SQL contracts: u=user, e=organization_people,
// $2=current authenticated actor, $3=current workspace administrator permission.
export const employeeVisibilitySQL =
  "(coalesce(e.visibility,'workspace')='workspace' OR u.id=$2 OR $3::boolean)";
