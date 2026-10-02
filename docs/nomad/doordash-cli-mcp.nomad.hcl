job "doordash-cli-mcp" {
  datacenters = ["dc1"]
  type        = "service"

  constraint {
    attribute = "${attr.kernel.name}"
    value     = "linux"
  }

  constraint {
    attribute = "${attr.cpu.arch}"
    value     = "amd64"
  }

  update {
    max_parallel      = 1
    min_healthy_time  = "15s"
    healthy_deadline  = "3m"
    progress_deadline = "10m"
    auto_revert       = true
  }

  group "app" {
    count = 1

    network {
      port "http" {
        to = 8787
      }
    }

    service {
      name = "doordash-cli-mcp"
      port = "http"

      meta {
        public_hostname = "doordash.example.com"
      }

      check {
        name     = "doordash-cli-mcp-ready"
        type     = "http"
        path     = "/health/ready"
        interval = "10s"
        timeout  = "3s"
      }
    }

    restart {
      attempts = 3
      interval = "5m"
      delay    = "10s"
      mode     = "delay"
    }

    task "doordash-cli-mcp" {
      driver = "docker"

      config {
        image = "ghcr.io/francisschmaltz/doordash-cli-mcp:latest"
        ports = ["http"]

        auth {
          username       = "francisschmaltz"
          password       = "CHANGEME"
          server_address = "ghcr.io"
        }
      }

      env {
        NODE_ENV = "production"
        HOST     = "0.0.0.0"
        PORT     = "8787"
      }

      template {
        destination = "secrets/doordash-cli-mcp.env"
        env         = true
        change_mode = "restart"

        data = <<-EOT
          {{ with nomadVar "nomad/jobs/doordash-cli-mcp" }}
          DATABASE_URL={{ .database_url | toJSON }}
          DATABASE_SSL={{ .database_ssl | toJSON }}
          DATABASE_SSL_REJECT_UNAUTHORIZED={{ .database_ssl_reject_unauthorized | toJSON }}
          ADMIN_ACCESS_TOKEN={{ .admin_access_token | toJSON }}
          DD_CLI_ACCESS_TOKEN={{ .dd_cli_access_token | toJSON }}
          {{ end }}
        EOT
      }

      resources {
        cpu    = 500
        memory = 512
      }

      kill_signal  = "SIGTERM"
      kill_timeout = "30s"
    }
  }
}
