package com.eventticketing.admin.client;

/** Carries a user-facing message extracted from a failed event-ticketing API call. */
public class TicketingApiException extends RuntimeException {

    private final int status;

    public TicketingApiException(int status, String message) {
        super(message);
        this.status = status;
    }

    public int getStatus() {
        return status;
    }
}
