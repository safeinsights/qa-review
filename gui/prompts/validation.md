/qa-validate The browser is open (not yet logged in) against {{target}}. Your goal is to Validate Jira ticket {{jiraCard}}: read the ticket (jira-atlassian MCP), it's comments and its PR (gh) to learn what changed and needs to be validated.

Before testing, confirm the code referenced in the Jira card is present on instance environment being used - if not, stop the validation and request clarification if testing should proceed.

 Infer the role that should be utilized and state the acceptance criteria and plan plainly.
 
 When approved, log in via `qar session-login --role <role>`, then drive the browser via the opened chrome-devtools MCP to verify the acceptance criteria. 

If the ticket links a Figma design (check remote links and comments, not just the description), compare the implementation against it and report any deviations separately from the acceptance criteria.

Give a clear PASS/FAIL verdict, noting any issues or errors are first on the new Jira comment.

