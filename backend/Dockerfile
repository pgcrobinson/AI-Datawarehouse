FROM python:3.12-slim

# System deps + Microsoft ODBC Driver 18 for SQL Server
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl gnupg2 apt-transport-https ca-certificates \
        unixodbc-dev gcc g++ git \
    && curl -fsSL https://packages.microsoft.com/keys/microsoft.asc \
        | gpg --dearmor -o /usr/share/keyrings/microsoft.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/microsoft.gpg] \
        https://packages.microsoft.com/debian/12/prod bookworm main" \
        > /etc/apt/sources.list.d/mssql-release.list \
    && apt-get update \
    && ACCEPT_EULA=Y apt-get install -y --no-install-recommends msodbcsql18 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# /home is the Azure App Service persistent mount point.
# DATA_DIR controls where SQLite db and dbt projects are stored.
ENV DATA_DIR=/home/data

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
