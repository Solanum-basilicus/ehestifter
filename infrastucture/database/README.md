# Database Schema – Ehestifter

This folder contains the SQL schema definitions for the Ehestifter project's operational database, deployed to **Azure SQL**.

## 📁 Structure

| File                          | Description                                 |
|------------------------------|---------------------------------------------|
| `01_job_offerings.sql`       | Normalized job offering table               |
| `02_job_offering_history.sql`| Event log/history per job offering          |
| `03_users.sql`               | AD B2C-backed user registry                 |
| `04_user_preferences.sql`    | User-uploaded CVs and filter criteria       |
| `05_enrichment_results.sql`  | Stores per-enricher execution outputs       |
| `06_compatibility_scores.sql`| Score between user & job (0–10)             |
| `07_user_job_status.sql`     | Current job status for a user               |
| `08_system_config.sql`       | System-wide config settings                 |
| `deploy.sql`                 | SQLCMD-compatible script to deploy schema   |

## 🛠️ Deployment

To deploy all schema objects at once:

```bash
sqlcmd -S <server>.database.windows.net -d <dbname> -U <user> -P <pass> -i deploy.sql
```
Ensure sqlcmd is installed and your IP is whitelisted in Azure SQL Firewall.

Or just run each script individually over your DB connection.