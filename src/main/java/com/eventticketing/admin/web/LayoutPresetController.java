package com.eventticketing.admin.web;

import com.eventticketing.admin.client.TicketingApiException;
import com.eventticketing.admin.client.TicketingClient;
import com.eventticketing.admin.client.dto.CreateLayoutPresetRequest;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Browser-facing proxy for layout presets: the hall editor calls these instead of the ticketing API
 * directly, so the API stays behind the admin app's session security.
 *
 * <p>API failures keep their status where it carries meaning — notably 409 for a duplicate preset
 * name, which the editor turns into "pick another name" rather than a generic error.
 */
@RestController
@RequestMapping("/layout-presets")
public class LayoutPresetController {

    private final TicketingClient client;

    public LayoutPresetController(TicketingClient client) {
        this.client = client;
    }

    @GetMapping
    public ResponseEntity<?> list() {
        try {
            return ResponseEntity.ok(client.listLayoutPresets());
        } catch (TicketingApiException ex) {
            return relay(ex);
        }
    }

    @GetMapping("/{id}")
    public ResponseEntity<?> get(@PathVariable Long id) {
        try {
            return ResponseEntity.ok(client.getLayoutPreset(id));
        } catch (TicketingApiException ex) {
            return relay(ex);
        }
    }

    @PostMapping
    public ResponseEntity<?> create(@RequestBody CreateLayoutPresetRequest request) {
        try {
            return ResponseEntity.ok(client.createLayoutPreset(request));
        } catch (TicketingApiException ex) {
            return relay(ex);
        }
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<?> delete(@PathVariable Long id) {
        try {
            client.deleteLayoutPreset(id);
            return ResponseEntity.noContent().build();
        } catch (TicketingApiException ex) {
            return relay(ex);
        }
    }

    private ResponseEntity<String> relay(TicketingApiException ex) {
        HttpStatus status = HttpStatus.resolve(ex.getStatus());
        if (status == null || !status.isError()) {
            status = HttpStatus.BAD_REQUEST;
        }
        return ResponseEntity.status(status).body(ex.getMessage());
    }
}
