# Sample main.R
library(osenclave)
library(httr)
library(ggplot2)
library(xtable)
library(dplyr)
library(lubridate)
library(readr)

###############################################################################
# Initialize Research Container
# DO NOT TOUCH
osenclave::initialize()
###############################################################################
# Researcher: Insert query code here

# Date range for Tutor query
date_from <- "2023-01-01"
date_to   <- "2023-02-28"

# OpenStax Tutor Example: Fetch rows for date range
tutor_results <- osenclave::query_tutor(sprintf("
  SELECT *
  FROM tutor_data
  WHERE created_at >= '%s' AND created_at <= '%s'
  LIMIT 1000
", date_from, date_to))

# OpenStax Tutor Exercises Example: Fetch rows from exercises data
exercises_results <- osenclave::query_tutor_exercises("
  SELECT *
  FROM exercises_data
  LIMIT 200
")

###############################################################################
# Researcher: Insert data manipulation and analysis code here

# Output file paths
tutor_output     <- "tutor_results.csv"
exercises_output <- "exercises_results.csv"
agg_output       <- "tasks_over_time_agg.csv"
plot_output      <- "plot.png"
table_output     <- "table.html"
archive_output   <- "archive.zip"

# Coerce every column to character and write the data frame to CSV. Coercing a
# local copy keeps IDs/codes from being mangled into numerics on export while
# leaving the original (typed) data intact for the analysis below.
write_results_csv <- function(df, path) {
  df[] <- lapply(df, as.character)
  write.csv(df, path, row.names = FALSE)
  invisible(path)
}

write_results_csv(tutor_results, tutor_output)
write_results_csv(exercises_results, exercises_output)

# Create a plot object
tasks_over_time <- tutor_results |>
  dplyr::filter(!is.na(first_completed_at)) |>
  mutate(date_first_completed_at = date(first_completed_at)) |>
  group_by(
    book_title, task_type, course_id, period_id,
    research_identifier, date_first_completed_at
  ) |>
  count(name = "task_type_counts") |>
  ungroup()

# Aggregating tasks over time across students
tasks_over_time_agg <- tasks_over_time |>
  group_by(
    book_title, task_type, course_id, period_id, date_first_completed_at
  ) |>
  summarize(
    median_engagement_beh = median(task_type_counts, na.rm = TRUE),
    num_students = n_distinct(research_identifier),
    .groups = "drop"
  )

# Save results locally
write_csv(tasks_over_time_agg, agg_output)

# Plot average tasks over time
plot1 <- tasks_over_time_agg |>
  ggplot(aes(
    x = date_first_completed_at, y = num_students, colour = task_type
  )) +
  facet_wrap(~book_title, labeller = label_wrap_gen(width = 10)) +
  geom_line() +
  theme_minimal() +
  theme(legend.position = "bottom")

# Save the plot
ggsave(filename = plot_output, plot = plot1, width = 6, height = 4, dpi = 300)

# Save a table: preview the first rows of the aggregated results
sample_table <- head(tasks_over_time_agg, 10)
print(
  xtable(sample_table),
  type = "html", file = table_output, include.rownames = FALSE
)

# Define the files you want to include
files_to_zip <- c(
  tutor_output, exercises_output, agg_output, plot_output, table_output
)

# Create the zip archive
utils::zip(zipfile = archive_output, files = files_to_zip)

###############################################################################
# Researcher: Upload results
toa_results_upload_beta <- function(...) {
  toa_endpoint <- Sys.getenv("TRUSTED_OUTPUT_ENDPOINT")

  if (toa_endpoint == "") {
    message("Trusted Output App endpoint not configured. Skipping upload.")
    return(invisible(NULL))
  }

  file_paths <- c(...)

  if (length(file_paths) == 0) {
    stop("No file paths provided.")
  }

  missing_files <- file_paths[!file.exists(file_paths)]
  if (length(missing_files) > 0) {
    stop(sprintf(
      "File(s) not found: %s", paste(missing_files, collapse = ", ")
    ))
  }

  # Create a named list for the body
  file_list <- lapply(file_paths, httr::upload_file)
  names(file_list) <- rep("file", length(file_paths))

  response <- httr::POST(
    url = paste0(toa_endpoint, "/upload"),
    body = file_list,
    encode = "multipart"
  )

  status_code <- httr::status_code(response)
  if (status_code != 200) {
    stop(sprintf("File upload failed. Status code: %d", status_code))
  }

  response_content <- tryCatch(
    httr::content(response, as = "parsed", type = "application/json"),
    error = function(e) {
      message("Could not parse JSON response.")
      NULL
    }
  )

  if (!is.null(response_content)) {
    print(response_content)
  } else {
    print(httr::content(response, as = "text", encoding = "UTF-8"))
  }
}

# Upload all of the files
toa_results_upload_beta(
  tutor_output, exercises_output, agg_output,
  plot_output, table_output, archive_output
)

# osenclave::toa_results_upload(
#   tutor_output, exercises_output, agg_output,
#   plot_output, table_output, archive_output
# )
