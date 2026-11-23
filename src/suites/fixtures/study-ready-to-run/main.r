library(osenclave)

###############################################################################
# Initialize Research Container
# DO NOT TOUCH
initialize()
###############################################################################
# Queries no table, so the job does not depend on which datasets the chosen
# Data Partner holds.

results <- data.frame(check = "qa-study-ready-to-run", value = 1)
write.csv(results, "results.csv", row.names = FALSE)

###############################################################################
# Researcher: Upload results
toa_results_upload("results.csv")
